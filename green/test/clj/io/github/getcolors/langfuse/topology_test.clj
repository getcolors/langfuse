(ns io.github.getcolors.langfuse.topology-test
  (:require [clojure.test :refer [deftest is testing]]
            [io.github.getcolors.langfuse.topology :as t]
            [io.github.getcolors.langfuse.validate-test :refer [base]]))

(def opts (assoc base :green/event :build))

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

(alter-var-root #'params (fn [value] (update value :nodes #(mapv (fn [node] (assoc node :provider "vultr" :node_id (str (:role node) "-" (:index node)))) %))))
(deftest declared-topology-and-entry-are-application-owned
  (is (= [{:role "neon" :count 1} {:role "redis" :count 1} {:role "clickhouse" :count 3} {:role "app" :count 1}] (t/topology opts)))
  (is (= "app-0" (:entry_node_id (t/requirements opts)))))
(deftest missing-and-partial-inventory-refuse-real-work
  (is (thrown? Exception (t/hosts (assoc opts :green/event :create))))
  (is (thrown? Exception (t/hosts opts (update params :nodes pop)))))
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
