(ns io.github.getcolors.langfuse.workflow-test
  (:require [clojure.test :refer [deftest is testing]] [clojure.java.io :as io]
            [green.workflow :as wf]
            [io.github.getcolors.langfuse.workflow :as w]
            [io.github.getcolors.langfuse.tools :as tools]
            [io.github.getcolors.langfuse.validate-test :refer [base creds]]
            [io.github.getcolors.langfuse.topology-test :refer [params]]
            [io.github.getcolors.compute-orchestration :as orchestration]
            [io.github.getcolors.compute-inspection :as inspection]))
(defn successors [step event] (vec (rest (w/wire-fn step {:green/event event}))))
(deftest application-and-delete-order-retained
  (is (= [:langfuse/infrastructure] (successors :langfuse/start :create)))
  (is (= [:langfuse/dns] (successors :langfuse/infrastructure :create)))
  (is (= [:langfuse/ssh-config] (successors :langfuse/dns :create)))
  (is (= [:langfuse/ansible] (successors :langfuse/ssh-config :create)))
  (is (= [:langfuse/ansible] (successors :langfuse/start :delete)))
  (is (= [] (successors :langfuse/infrastructure :delete))))
(deftest inspection-is-fail-closed-for-every-state-verb
  (with-redefs [inspection/read-deployment (fn [& _] {:status "error"})]
    (doseq [event [:delete :describe :rehearse]]
      (is (= 1 (:green/exit (w/start-step (merge base creds {:green/event event :compute-prevent-destroy false}) {})))))))
(deftest native-build-never-fetches-or-reads-state-and-renders-neon-from-pin
  (doseq [external? [false true]]
    (let [dir (.toFile (java.nio.file.Files/createTempDirectory "langfuse-build-" (make-array java.nio.file.attribute.FileAttribute 0)))]
      (try
        (with-redefs [orchestration/orchestrate (fn [& _] (throw (AssertionError. "no cloud in build")))
                      inspection/read-deployment (fn [& _] (throw (AssertionError. "no state in build")))
                      tools/fetch-cloudflare-ranges (fn [] (throw (AssertionError. "no HTTP in build")))]
          (let [opts (cond-> (assoc base :green/event :build :workdir (.getPath dir)) external? (assoc :vultr-ssh-keys "external-key" :ssh-private-key-path "/tmp/external"))
                result (wf/run w/workflow opts) files (file-seq dir)]
            (is (= 0 (:green/exit result)) (:green/err result))
            (is (= 6 (count (filter #(= "node.tf.json" (.getName %)) files))))
            (is (some #(= "compose.yml" (.getName %)) files))))
        (finally (doseq [file (reverse (file-seq dir))] (io/delete-file file)))))))
(deftest managed-backend-outlives-all-application-states
  (let [create {:green/event :create :langfuse-storage-managed true :s3-bucket-mode "managed"}
        delete (assoc create :green/event :delete)]
    (is (= [:langfuse/storage] (vec (rest (w/wire-fn :langfuse/infrastructure create)))))
    (is (= [:langfuse/dns] (vec (rest (w/wire-fn :langfuse/storage create)))))
    (is (= [:langfuse/storage] (vec (rest (w/wire-fn :langfuse/dns delete)))))
    (is (= [:langfuse/infrastructure] (vec (rest (w/wire-fn :langfuse/storage delete)))))
    (is (= [:langfuse/backend-finalize] (vec (rest (w/wire-fn :langfuse/infrastructure delete)))))
    (is (= [] (vec (rest (w/wire-fn :langfuse/backend-finalize delete)))))))
