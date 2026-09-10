(ns io.github.getcolors.langfuse.storage-test
  (:require [clojure.test :refer [deftest is]]
            [clojure.java.shell :as shell]
            [green.tofu :as tofu]
            [cheshire.core :as json]
            [green.process :as process]
            [io.github.getcolors.langfuse.storage :as storage]
            [io.github.getcolors.langfuse.validate :as validate]
            [io.github.getcolors.langfuse.validate-test :refer [base]]))
(def managed (assoc base :provider-backend "s3" :s3-bucket "langfuse-state" :s3-region "us-east-1"
                        :langfuse-storage-managed true :langfuse-storage-provider "s3"
                        :neon-r2-bucket "langfuse-neon" :neon-r2-region "us-east-1"
                        :langfuse-backup-r2-region "us-east-1"))
(def credentials {:credentials (into {} (for [role [:neon :data :backup]]
                                         [role {:access_key_id (str (name role) "-id") :secret_access_key (str (name role) "-secret") }]))})
(deftest managed-s3-validation-and-credential-requirements
  (is (empty? (validate/state-errors (dissoc managed :r2-bucket :r2-endpoint))))
  (doseq [change [{:langfuse-storage-provider "r2"} {:langfuse-storage-managed "true"}
                  {:neon-r2-region "auto"} {:langfuse-backup-r2-region "eu-west-1"}
                  {:neon-r2-bucket (:langfuse-s3-bucket managed)}
                  {:s3-bucket (:langfuse-s3-bucket managed)}]]
    (is (seq (validate/state-errors (merge managed change)))))
  (is (= #{"required credential is not set: COLORS_PAR_CLOUDFLARE_API_TOKEN"
           "required credential is not set: COLORS_PAR_LANGFUSE_ENCRYPTION_KEY"
           "required credential is not set: COLORS_PAR_LANGFUSE_SALT"
           "required credential is not set: COLORS_PAR_LANGFUSE_INIT_USER_PASSWORD"}
         (set (validate/secret-errors managed :create)))))
(deftest three-bucket-identities-reach-the-existing-secret-lookups
  (let [environment (storage/credential-env (assoc managed :langfuse/storage-credentials credentials))]
    (is (= "neon-id" (get environment "COLORS_PAR_NEON_R2_ACCESS_KEY_ID")))
    (is (= "data-secret" (get environment "COLORS_PAR_LANGFUSE_STORAGE_R2_SECRET_ACCESS_KEY")))
    (is (= "backup-id" (get environment "COLORS_PAR_LANGFUSE_BACKUP_R2_ACCESS_KEY_ID")))
    (is (nil? (get environment "AWS_ACCESS_KEY_ID"))))
  (is (thrown? Exception (storage/credential-env managed))))
(deftest ownership-rejects-untracked-existing-buckets-and-unknown-state
  (doseq [probe [{:exit 0 :out ""} {:exit 1 :err "(403) Forbidden"}]]
    (with-redefs [process/run (fn [args _] (if (= "aws" (first args)) probe {:exit 0 :out ""}))]
      (is (thrown? Exception (storage/ownership-preflight! managed)))))
  (with-redefs [process/run (fn [args _] (if (= args ["tofu" "state" "list"]) {:exit 1 :err "AccessDenied"} {:exit 0 :out ""}))]
    (is (thrown? Exception (storage/ownership-preflight! managed)))))
(deftest first-create-probes-all-three-buckets
  (let [probes (atom [])]
    (with-redefs [process/run (fn [args _]
                               (cond
                                 (= args ["tofu" "state" "list"]) {:exit 1 :err "No state file was found!"}
                                 (= "aws" (first args)) (do (swap! probes conj (nth args 4)) {:exit 254 :err "(404) Not Found"})
                                 :else {:exit 0 :out ""}))]
      (storage/ownership-preflight! managed)
      (is (= #{"langfuse-neon" "langfuse-storage" "langfuse-backup"} (set @probes))))))
(deftest tracked-address-must-also-match-bucket-name
  (with-redefs [process/run (fn [args _]
                             (cond
                               (= args ["tofu" "state" "list"]) {:exit 0 :out "aws_s3_bucket.application[\"neon\"]"}
                               (= args ["tofu" "show" "-json"]) {:exit 0 :out (json/generate-string {:values {:root_module {:resources [{:address "aws_s3_bucket.application[\"neon\"]" :values {:bucket "foreign-old-name"}}]}}})}
                               :else {:exit 0 :out ""}))]
    (is (thrown? Exception (storage/ownership-preflight! managed)))))
(deftest adopted-storage-does-not-provision
  (with-redefs [process/run (fn [& _] (throw (AssertionError. "adopted storage must not provision")))]
    (is (= 0 (:green/exit (storage/step base))))))

(deftest sensitive-tofu-json-reaches-ansible-with-nested-string-keys
  ;; Exercise the real SDK decoder: only the top-level output key is keywordized.
  (let [wire (json/generate-string
               {:credentials {:sensitive true :type ["object" {}] :value (:credentials credentials)}})
        calls (atom [])]
    (with-redefs [shell/sh (fn [& args]
                            (swap! calls conj (take 3 args))
                            {:exit 0 :out wire :err ""})]
      (let [decoded (tofu/outputs "/unused")
            env (storage/credential-env (assoc managed :langfuse/storage-credentials decoded))]
        (is (contains? (:credentials decoded) "neon"))
        (is (= "neon-id" (get env "COLORS_PAR_NEON_R2_ACCESS_KEY_ID")))
        (is (= "data-secret" (get env "COLORS_PAR_LANGFUSE_STORAGE_R2_SECRET_ACCESS_KEY")))
        (is (= "backup-secret" (get env "COLORS_PAR_LANGFUSE_BACKUP_R2_SECRET_ACCESS_KEY")))
        (is (= [["tofu" "output" "-json"]] @calls))))))
