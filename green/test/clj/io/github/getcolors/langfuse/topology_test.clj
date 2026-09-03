(ns io.github.getcolors.langfuse.topology-test
  (:require [clojure.test :refer [deftest is testing]]
            [io.github.getcolors.langfuse.topology :as t]))

(def opts {:profile "langfuse-test" :vultr-vpc-subnet "10.50.0.0/24"})

(deftest six-machines-in-play-order
  (let [hs (t/hosts opts)]
    (is (= 6 (count hs)))
    (is (= ["langfuse-test-neon" "langfuse-test-redis"
            "langfuse-test-clickhouse-0" "langfuse-test-clickhouse-1" "langfuse-test-clickhouse-2"
            "langfuse-test-app"]
           (map :name hs)))
    (testing "the app host is last: it is the consumer of the other three tiers"
      (is (= "app" (:role (last hs)))))))

(deftest fallbacks-are-fixed-and-inside-the-subnet
  (let [hs (t/hosts opts)]
    (is (every? #(re-matches #"192\.0\.2\.\d+" (:ip %)) hs))
    (is (every? #(re-matches #"10\.50\.0\.\d+" (:vpc-ip %)) hs))
    (is (= 6 (count (distinct (map :vpc-ip hs)))) "no two placeholders collide")))

(deftest compute-name-honours-the-override
  (is (= "langfuse-test" (t/compute-name opts)))
  (is (= "custom" (t/compute-name (assoc opts :vultr-name "custom"))))
  (is (= "langfuse-test" (t/compute-name (assoc opts :vultr-name "REPLACE_ME")))))

(deftest real-params-replace-the-fallbacks-by-role-and-index
  (let [params [{:role "neon" :index nil :ip "1.1.1.1" :vpc-ip "10.50.0.2"}
                {:role "redis" :index nil :ip "1.1.1.2" :vpc-ip "10.50.0.3"}
                {:role "clickhouse" :index 0 :ip "1.1.1.3" :vpc-ip "10.50.0.4"}
                {:role "clickhouse" :index 1 :ip "1.1.1.4" :vpc-ip "10.50.0.5"}
                {:role "clickhouse" :index 2 :ip "1.1.1.5" :vpc-ip "10.50.0.6"}
                {:role "app" :index nil :ip "1.1.1.6" :vpc-ip "10.50.0.7"}]
        hs (t/hosts opts params)]
    (is (= "10.50.0.7" (:vpc-ip (t/host-of hs :app))))
    (is (= "1.1.1.4" (:ip (t/host-of hs :clickhouse 1))))
    (is (= [0 1 2] (map :index (t/clickhouse-hosts hs))))
    (is (nil? (t/missing-host-error opts params)))))

(deftest a-partial-compute-output-is-refused
  (testing "a two-replica cluster config forms no quorum; refuse rather than render"
    (let [params [{:role "neon" :index nil :ip "1.1.1.1" :vpc-ip "10.50.0.2"}
                  {:role "clickhouse" :index 0 :ip "1.1.1.3" :vpc-ip "10.50.0.4"}]]
      (is (re-find #"clickhouse-1" (t/missing-host-error opts params)))
      (is (re-find #"app" (t/missing-host-error opts params))))
    (testing "an address-less host counts as missing"
      (is (t/missing-host-error opts [{:role "neon" :index nil :ip "" :vpc-ip "10.50.0.2"}])))))

(deftest ports-come-from-desired-state-with-defaults
  (is (= [8123 9000] (t/app-clickhouse-ports opts)))
  (is (= [9000 9009 9181 9234] (t/clickhouse-internal-ports opts)))
  (is (= [8124 9001] (t/app-clickhouse-ports (assoc opts :clickhouse-http-port 8124 :clickhouse-native-port "9001"))))
  (is (= 6379 (t/redis-port opts))))
