(ns io.github.getcolors.langfuse.validate-test
  "Regression tests for the rules a fresh colors.yml gets wrong. Each deftest
  names the failure it prevents."
  (:require [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.langfuse.validate :as v]))

(def base
  "A minimal valid desired state, kept complete on purpose: `state-errors`
  reports every problem at once, so a fixture missing keys would make every
  test read as a pass-by-accident."
  {:profile "langfuse-test" :workdir ".colors"
   :provider-compute "vultr" :provider-dns "cloudflare" :provider-backend "r2"
   :compute-prevent-destroy true
   :langfuse-image "docker.langfuse.com/langfuse/langfuse:4.27.0@sha256:c9e2cab8469a5d7353e86a3252b02c52ac94ef31288ce2639ee01aabf5e4222b"
   :langfuse-worker-image "docker.langfuse.com/langfuse/langfuse-worker:4.27.0@sha256:091a85c3c54bf5fff7cc0073a7f35a52861cc0e30d33dd05569fe3ed66b15d8d"
   :langfuse-host "langfuse.example.com"
   :langfuse-init-org-id "org" :langfuse-init-org-name "Org"
   :langfuse-init-project-id "project" :langfuse-init-project-name "Project"
   :langfuse-init-user-email "operator@example.com" :langfuse-init-user-name "Operator"
   :langfuse-s3-bucket "langfuse-storage" :langfuse-s3-prefix "langfuse-test/"
   :langfuse-smoke-traces 200 :langfuse-smoke-timeout-seconds 120
   :caddy-image "docker.io/library/caddy:2.11.4@sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d"
   :redis-image "docker.io/library/redis:7.2.16@sha256:74566c6910d13ae61e7ce73ebd3127438a1fe805b309b097c323142719ec8a5b"
   :redis-port 6379
   :clickhouse-version "26.3.29.7" :clickhouse-cluster-name "default" :clickhouse-nodes 3
   :clickhouse-http-port 8123 :clickhouse-native-port 9000 :clickhouse-interserver-port 9009
   :clickhouse-keeper-port 9181 :clickhouse-raft-port 9234
   :neon-image "ghcr.io/neondatabase/neon:release-9129@sha256:166022a72bf9983eba96d061d794f4740edbd4c3301e66202c1180acce9a323c"
   :neon-compute-image "ghcr.io/neondatabase/compute-node-v17:release-compute-9073@sha256:ed6a613231d7026b4df8b00563444b9f33745370a3b3f0a2183e723f460ba974"
   :neon-pg-version 17
   :neon-tenant-id "7b3c1e94a05d42f8b6c9e2417d580a3f" :neon-timeline-id "4f8a2d61c93b47e0a5d8f1620b7c94e3"
   :neon-database "langfuse" :neon-role "langfuse"
   :neon-r2-bucket "langfuse-storage" :neon-r2-endpoint "https://example.r2.cloudflarestorage.com"
   :neon-r2-region "auto" :neon-r2-prefix "langfuse-test/neon"
   :langfuse-backup-r2-bucket "langfuse-backup" :langfuse-backup-r2-endpoint "https://example.r2.cloudflarestorage.com"
   :langfuse-backup-r2-region "auto"
   :langfuse-postgres-backup-oncalendar "*-*-* 00/6:00:00" :langfuse-clickhouse-backup-oncalendar "*-*-* 02:30:00"
   :langfuse-media-backup-oncalendar "*-*-* 03:30:00" :langfuse-backup-retention-days 7
   :langfuse-postgres-backup-max-age-hours 8 :langfuse-clickhouse-backup-max-age-hours 30
   :langfuse-media-backup-max-age-hours 30
   :cloudflare-zone "example.com" :cloudflare-record-name "langfuse" :cloudflare-proxied true
   :vultr-region "ams" :vultr-os-id 2284 :vultr-vpc-subnet "10.50.0.0/24"
   :vultr-plan-neon "vc2-4c-8gb" :vultr-plan-redis "vc2-1c-2gb"
   :vultr-plan-clickhouse "vc2-4c-8gb" :vultr-plan-app "vc2-4c-8gb"
   :vultr-ssh-sources ["0.0.0.0/0"] :vultr-http-sources "cloudflare"
   :r2-bucket "tofu-state-example" :r2-endpoint "https://example.r2.cloudflarestorage.com"})

(def creds
  {:vultr-api-key "v" :cloudflare-api-token "c"
   :r2-access-key-id "state" :r2-secret-access-key "state-secret"
   :neon-r2-access-key-id "store" :neon-r2-secret-access-key "store-secret"
   :langfuse-storage-r2-access-key-id "store" :langfuse-storage-r2-secret-access-key "store-secret"
   :langfuse-backup-r2-access-key-id "backup" :langfuse-backup-r2-secret-access-key "backup-secret"
   :langfuse-encryption-key (apply str (repeat 64 "a"))
   :langfuse-salt (apply str (repeat 32 "s"))
   :langfuse-init-user-password "twelve-chars!"})

(defn errs [m] (v/state-errors (merge base m)))
(defn has? [m needle] (boolean (some #(re-find (re-pattern needle) %) (errs m))))
(defn secret-errs [m] (v/secret-errors (merge base creds m) :create))
(defn secret-has? [m needle] (boolean (some #(re-find (re-pattern needle) %) (secret-errs m))))

(deftest a-complete-desired-state-validates
  (is (empty? (errs {}))))

(deftest reports-every-problem-at-once
  (is (<= 3 (count (errs {:neon-pg-version 12 :redis-port nil :vultr-os-id "x"})))))

;; --- version rules ------------------------------------------------------------

(deftest clickhouse-must-be-new-enough-for-langfuse-v4
  (testing "v4 requires >= 25.12; a 24.x or 25.8 pin converges and then fails
            the first migration"
    (is (has? {:clickhouse-version "24.3.10.1"} "25.12 or newer"))
    (is (has? {:clickhouse-version "25.8.1.1"} "25.12 or newer"))
    (is (empty? (errs {:clickhouse-version "25.12.1.1"})))
    (is (empty? (errs {:clickhouse-version "26.8.2.7"})))))

(deftest clickhouse-version-must-be-an-exact-apt-version
  (is (has? {:clickhouse-version "26.3"} "four-part apt version"))
  (is (has? {:clickhouse-version "latest"} "four-part apt version")))

(deftest the-cluster-must-be-named-default
  (testing "Langfuse's bundled migrations run ON CLUSTER default"
    (is (has? {:clickhouse-cluster-name "langfuse"} "must be default"))))

(deftest exactly-three-clickhouse-nodes
  (is (has? {:clickhouse-nodes 1} "must be 3"))
  (is (has? {:clickhouse-nodes 5} "must be 3")))

(deftest web-and-worker-versions-must-match
  (is (has? {:langfuse-worker-image "docker.langfuse.com/langfuse/langfuse-worker:4.26.0@sha256:091a85c3c54bf5fff7cc0073a7f35a52861cc0e30d33dd05569fe3ed66b15d8d"}
            "must equal")))

(deftest images-must-be-digest-pinned
  (is (has? {:langfuse-image "docker.langfuse.com/langfuse/langfuse:4.27.0"} "pinned by digest"))
  (is (has? {:redis-image "docker.io/library/redis:7.2.16"} "pinned by digest")))

;; --- the coupling that only fails later ---------------------------------------

(deftest cloudflare-only-ingress-requires-a-proxied-record
  (is (has? {:cloudflare-proxied false} "ACME HTTP-01"))
  (is (empty? (errs {:vultr-http-sources ["1.2.3.0/24"] :cloudflare-proxied false}))))

(deftest s3-prefix-must-end-with-a-slash
  (testing "Langfuse concatenates the prefix without one"
    (is (has? {:langfuse-s3-prefix "langfuse-test"} "end with a slash"))))

;; --- blast radius ---------------------------------------------------------------

(deftest live-data-must-not-share-a-bucket-with-tofu-state
  (is (has? {:neon-r2-bucket "tofu-state-example"} "must not be the OpenTofu state bucket"))
  (is (has? {:langfuse-s3-bucket "tofu-state-example"} "must not be the OpenTofu state bucket")))

(deftest backups-must-not-share-a-bucket-with-state-or-live-data
  (is (has? {:langfuse-backup-r2-bucket "tofu-state-example"} "must not be the state or a live-data bucket"))
  (is (has? {:langfuse-backup-r2-bucket "langfuse-storage"} "must not be the state or a live-data bucket")))

(deftest sharing-one-r2-credential-must-be-a-deliberate-choice
  (testing "the storage pair equal to the state pair is refused"
    (is (secret-has? {:neon-r2-access-key-id "state" :neon-r2-secret-access-key "state-secret"}
                     "same R2 credential as OpenTofu state")))
  (testing "the backup pair equal to the storage pair is refused"
    (is (secret-has? {:langfuse-backup-r2-access-key-id "store" :langfuse-backup-r2-secret-access-key "store-secret"}
                     "same R2 credential as live data")))
  (testing "scoped pairs satisfy it with no opt-out"
    (is (empty? (secret-errs {}))))
  (testing "the shared pair is reachable only as a recorded, committed choice"
    (is (empty? (secret-errs {:r2-credential-sharing "shared-accepted"
                              :neon-r2-access-key-id "state" :neon-r2-secret-access-key "state-secret"})))
    (is (has? {:r2-credential-sharing "yes-whatever"} "must be split or shared-accepted"))))

;; --- operator-held application secrets ------------------------------------------

(deftest the-encryption-key-must-be-64-hex
  (is (secret-has? {:langfuse-encryption-key "short"} "64 lowercase hex"))
  (is (secret-has? {:langfuse-encryption-key (apply str (repeat 64 "z"))} "64 lowercase hex")))

(deftest the-salt-and-init-password-have-floors
  (is (secret-has? {:langfuse-salt "short"} "at least 32 characters"))
  (is (secret-has? {:langfuse-init-user-password "short"} "at least 12 characters")))

(deftest every-operator-credential-is-required-on-create
  (doseq [k [:langfuse-encryption-key :langfuse-salt :langfuse-init-user-password
             :langfuse-backup-r2-access-key-id :langfuse-storage-r2-access-key-id
             :neon-r2-access-key-id :cloudflare-api-token :vultr-api-key]]
    (is (some #(re-find (re-pattern (green-cli/par-name k)) %) (secret-errs {k nil}))
        (str k " should be required"))))

(deftest a-delete-needs-only-the-provider-credentials
  (is (empty? (v/secret-errors (merge base {:vultr-api-key "v" :cloudflare-api-token "c"
                                            :r2-access-key-id "a" :r2-secret-access-key "b"})
                               :delete))))

;; --- storage tier identity --------------------------------------------------------

(deftest tenant-and-timeline-are-fixed-desired-state
  (doseq [k [:neon-tenant-id :neon-timeline-id]]
    (is (has? {k "not-hex"} "32 lowercase hex"))))

(deftest the-application-role-must-not-be-cloud-admin
  (is (has? {:neon-role "cloud_admin"} "must not be cloud_admin")))

(deftest the-vpc-subnet-must-be-a-cidr
  (is (has? {:vultr-vpc-subnet "10.50.0.0"} "IPv4 CIDR")))

(deftest profile-may-not-be-overlaid-from-the-environment
  (is (seq (v/env-errors {v/profile-par "somewhere-else"})))
  (is (empty? (v/env-errors {}))))
