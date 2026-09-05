(ns io.github.getcolors.langfuse.ssh-config-test
  (:require [clojure.test :refer [deftest is testing]]
            [io.github.getcolors.langfuse.ssh-config :as sc]
            [io.github.getcolors.langfuse.topology :as topology]))

(def opts {:profile "langfuse-test" :provider-compute "vultr" :vultr-vpc-subnet "10.50.0.0/24"})

(deftest the-bare-profile-plus-one-alias-per-machine
  (is (= ["langfuse-test" "langfuse-test-neon" "langfuse-test-redis"
          "langfuse-test-clickhouse-0" "langfuse-test-clickhouse-1" "langfuse-test-clickhouse-2"
          "langfuse-test-app"]
         (sc/aliases opts)))
  (is (= "~/.ssh/langfuse-test" (sc/identity-file opts)))
  (testing "the aliases follow the profile, not the machine label (Compute Cluster Standard §6)"
    (let [renamed (assoc opts :vultr-name "custom")]
      (is (= "langfuse-test-clickhouse-1"
             (sc/machine-alias renamed {:role "clickhouse" :index 1 :name "custom-clickhouse-1"})))
      (is (= "langfuse-test-app" (sc/machine-alias renamed {:role "app" :index nil :name "custom-app"})))
      (is (= (rest (sc/aliases renamed))
             (map #(sc/machine-alias renamed %) (topology/hosts renamed)))))))

(deftest a-foreign-stanza-for-any-alias-is-detected
  (testing "the marker is the profile; the stanza searched for may be a machine alias"
    (let [lines ["Host other" "  HostName 1.2.3.4"
                 "Host langfuse-test-clickhouse-1" "  HostName 5.6.7.8"]]
      (is (= 3 (sc/foreign-stanza-line lines "langfuse-test-clickhouse-1" "langfuse-test")))
      (is (nil? (sc/foreign-stanza-line lines "langfuse-test-app" "langfuse-test")))))
  (testing "our own block is skipped, whichever alias it names"
    (let [lines [(sc/begin-marker "langfuse-test")
                 "Host langfuse-test" "Host langfuse-test-redis"
                 (sc/end-marker "langfuse-test")]]
      (is (nil? (sc/foreign-stanza-line lines "langfuse-test-redis" "langfuse-test"))))))

(deftest a-global-option-above-the-first-host-blocks-the-insert
  (is (= 2 (sc/leading-option-line ["# comment" "ForwardAgent yes" "Host x"])))
  (is (nil? (sc/leading-option-line ["" "# c" "Host x" "  ForwardAgent yes"]))))
