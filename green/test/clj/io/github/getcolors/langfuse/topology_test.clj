(ns io.github.getcolors.langfuse.topology-test
  (:require [clojure.test :refer [deftest is testing]]
            [io.github.getcolors.langfuse.topology :as t]
            [io.github.getcolors.once.compute-cluster :as once-cluster]))

(def opts {:profile "langfuse-test" :provider-compute "vultr" :vultr-vpc-subnet "10.50.0.0/24"})

;; The compute stage's recorded `params`, as ONCE reads it: snake_case node
;; keys, every field present, a 0-based index on every node — the shape the
;; template outputs since adoption.
(def params
  {:provider "vultr" :ssh_key_id "7692e92a"
   :nodes [{:role "neon" :index 0 :name "langfuse-test-neon" :ip "1.1.1.1" :vpc_ip "10.50.0.2" :user "root" :sudoer "root"}
           {:role "redis" :index 0 :name "langfuse-test-redis" :ip "1.1.1.2" :vpc_ip "10.50.0.3" :user "root" :sudoer "root"}
           {:role "clickhouse" :index 0 :name "langfuse-test-clickhouse-0" :ip "1.1.1.3" :vpc_ip "10.50.0.4" :user "root" :sudoer "root"}
           {:role "clickhouse" :index 1 :name "langfuse-test-clickhouse-1" :ip "1.1.1.4" :vpc_ip "10.50.0.5" :user "root" :sudoer "root"}
           {:role "clickhouse" :index 2 :name "langfuse-test-clickhouse-2" :ip "1.1.1.5" :vpc_ip "10.50.0.6" :user "root" :sudoer "root"}
           {:role "app" :index 0 :name "langfuse-test-app" :ip "1.1.1.6" :vpc_ip "10.50.0.7" :user "root" :sudoer "root"}]})

(deftest the-spec-describes-six-vultr-machines-in-four-roles
  ;; The Compute Cluster Standard's spec-content test: the shape ONCE is handed
  ;; is data, and this is what that data must say.
  (is (= [] (once-cluster/spec-errors t/spec)))
  (is (= [{:role "neon" :count 1 :fallback-offset 10}
          {:role "redis" :count 1 :fallback-offset 11}
          {:role "clickhouse" :count 3 :fallback-offset 20}
          {:role "app" :count 1 :fallback-offset 12}]
         (:roles t/spec))
      "play order, app last: it is the consumer of the other three tiers")
  (is (= {:role "app" :index 0} (once-cluster/entry-id t/spec))
      "the bare profile alias reaches the app host")
  (is (= {:non-empty ["ssh-sources"] :may-be-empty []} (:sources t/spec))
      "vultr-http-sources is the package's own rule: it accepts the symbolic cloudflare")
  (is (= "vultr" (:default t/spec)))
  (is (= ["vultr"] (keys (:registry t/spec))))
  (is (= {:mode :created :key :vultr-vpc-subnet}
         (get-in t/spec [:registry "vultr" :network]))
      "every database connection crosses a VPC this package creates from vultr-vpc-subnet")
  (is (not (contains? t/spec :fallback-subnet))
      "a created network cuts its fallbacks from the CIDR key, not a stand-in")
  (is (= [:vultr-api-key] (get-in t/spec [:registry "vultr" :secrets])))
  (is (= [:vultr-region :vultr-os-id :vultr-vpc-subnet
          :vultr-plan-neon :vultr-plan-redis :vultr-plan-clickhouse :vultr-plan-app
          :vultr-ssh-sources :vultr-http-sources]
         (get-in t/spec [:registry "vultr" :required]))
      "every key the compute template interpolates, and nothing the standards make optional")
  (is (= [:neon :redis :clickhouse :app] t/roles)))

(deftest six-machines-in-play-order
  (let [hs (t/hosts opts)]
    (is (= 6 (count hs)))
    (is (= ["langfuse-test-neon" "langfuse-test-redis"
            "langfuse-test-clickhouse-0" "langfuse-test-clickhouse-1" "langfuse-test-clickhouse-2"
            "langfuse-test-app"]
           (map :name hs)))
    (testing "the app host is last: it is the consumer of the other three tiers"
      (is (= "app" (:role (last hs)))))
    (testing "a singleton carries no index; a replica carries its ordinal"
      (is (= [nil nil 0 1 2 nil] (map :index hs))))))

(deftest fallbacks-are-the-pre-adoption-addresses
  ;; ONCE's fallbacks at this package's offsets: TEST-NET-1 publicly, the VPC
  ;; subnet privately — the same six addresses the goldens carried before
  ;; adoption, because the ClickHouse cluster config and the firewall data
  ;; are rendered from them.
  (let [hs (t/hosts opts)]
    (is (= ["192.0.2.10" "192.0.2.11" "192.0.2.20" "192.0.2.21" "192.0.2.22" "192.0.2.12"]
           (mapv :ip hs)))
    (is (= ["10.50.0.10" "10.50.0.11" "10.50.0.20" "10.50.0.21" "10.50.0.22" "10.50.0.12"]
           (mapv :vpc-ip hs)))
    (is (not-any? #(contains? % :vpc_ip) hs))
    (is (every? #(= "root" (:user %) (:sudoer %)) hs))))

(deftest compute-name-honours-the-override
  (is (= "langfuse-test" (t/compute-name opts)))
  (is (= "custom" (t/compute-name (assoc opts :vultr-name "custom"))))
  (is (= "langfuse-test" (t/compute-name (assoc opts :vultr-name "REPLACE_ME"))))
  (is (= "custom-app" (t/machine-name (assoc opts :vultr-name "custom") :app)))
  (is (= "langfuse-test-clickhouse-2" (t/machine-name opts :clickhouse 2))))

(deftest hosts-on-a-real-run-come-from-state-in-the-renderers-spelling
  ;; ONCE hands back every node as recorded, `:vpc_ip` and index 0 and all;
  ;; this package's templates were written against `:vpc-ip` and the
  ;; inventory writes an ordinal for the replicas alone, so the wrapper
  ;; respells the one key and blanks a singleton's index. Nothing else is
  ;; touched: the name is the label the template gave the instance, never
  ;; recomputed, and extension fields ride through.
  (let [recorded (-> params
                     (assoc-in [:nodes 5 :name] "renamed-in-console")
                     (assoc-in [:nodes 0 :extra] "kept"))
        hs (t/hosts opts recorded)]
    (is (= "10.50.0.7" (:vpc-ip (t/host-of hs :app))))
    (is (= "1.1.1.4" (:ip (t/host-of hs :clickhouse 1))))
    (is (= [0 1 2] (map :index (t/clickhouse-hosts hs))))
    (is (not-any? #(contains? % :vpc_ip) hs))
    (is (= "renamed-in-console" (:name (t/host-of hs :app))))
    (is (= "kept" (:extra (t/host-of hs :neon))))
    (is (= [nil nil 0 1 2 nil] (map :index hs)))))

(deftest ports-come-from-desired-state-with-defaults
  (is (= [8123 9000] (t/app-clickhouse-ports opts)))
  (is (= [9000 9009 9181 9234] (t/clickhouse-internal-ports opts)))
  (is (= [8124 9001] (t/app-clickhouse-ports (assoc opts :clickhouse-http-port 8124 :clickhouse-native-port "9001"))))
  (is (= 6379 (t/redis-port opts))))
