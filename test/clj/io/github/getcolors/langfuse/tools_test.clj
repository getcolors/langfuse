(ns io.github.getcolors.langfuse.tools-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [cheshire.core :as json]
            [io.github.getcolors.langfuse.tools :as tools]
            [io.github.getcolors.langfuse.topology :as topology]))

(def opts {:profile "langfuse-test" :vultr-vpc-subnet "10.50.0.0/24"
           :langfuse-host "langfuse.example.com" :cloudflare-proxied true})

(deftest the-neon-bundle-renders-from-the-dependency-not-a-local-copy
  (let [specs (tools/neon-specs "/tmp/stage" {})]
    (is (= 12 (count specs)))
    (doseq [{:keys [template target]} specs]
      (is (str/starts-with? (namespace template) "io.github.getcolors.neon.tools")
          (str template " must come from the neon dependency"))
      (is (str/includes? target "/neon/")))))

(deftest every-package-template-is-listed-once
  (is (= (count tools/ansible-files) (count (distinct tools/ansible-files)))))

(deftest the-inventory-has-four-groups-and-only-host-vars
  (let [inv (json/parse-string (tools/inventory opts (topology/hosts opts)) true)
        groups (get-in inv [:all :children])]
    (is (= #{:neon :redis :clickhouse :app} (set (keys groups))))
    (is (= 3 (count (get-in groups [:clickhouse :hosts]))))
    (is (= 1 (count (get-in groups [:app :hosts]))))
    (testing "every value is a HOST var; no group carries variables"
      (is (every? #(nil? (:vars %)) (vals groups))))
    (let [ch1 (get-in groups [:clickhouse :hosts :langfuse-test-clickhouse-1])]
      (is (= 1 (:ordinal ch1)))
      (is (= "clickhouse" (:role ch1)))
      (is (re-matches #"10\.50\.0\.\d+" (:vpc_ip ch1))))
    (testing "singletons carry no ordinal"
      (is (nil? (:ordinal (get-in groups [:app :hosts :langfuse-test-app])))))))

(deftest normalize-params-speaks-kebab-case
  (let [p (tools/normalize-params {:ssh_key_id "k" :hosts [{:role "clickhouse" :index 1.0 :ip "1.1.1.1" :vpc_ip "10.0.0.1"}]})]
    (is (= "k" (:ssh-key-id p)))
    (is (= 1 (:index (first (:hosts p)))))
    (is (= "10.0.0.1" (:vpc-ip (first (:hosts p)))))))

(deftest the-ssh-config-block-carries-the-profile-first
  (let [hs (tools/ssh-config-hosts opts (topology/hosts opts))]
    (is (= "langfuse-test" (:name (first hs))))
    (is (= (:ip (topology/host-of (topology/hosts opts) :app)) (:ip (first hs))))
    (is (= 7 (count hs)))))

(deftest http-sources-resolve-explicit-lists-verbatim
  (let [{:keys [source ranges]} (tools/http-sources {:vultr-http-sources ["1.2.3.0/24" "::/0"]})]
    (is (= :explicit source))
    (is (= ["1.2.3.0/24" "::/0"] ranges))))

(deftest the-cloudflare-fallback-is-never-permissive
  (is (not-any? #{"0.0.0.0/0" "::/0"} tools/cloudflare-ranges-fallback))
  (is (< 10 (count tools/cloudflare-ranges-fallback))))

(deftest the-dns-record-is-proxied-with-an-automatic-ttl
  (let [doc (json/parse-string (tools/dns-json opts "203.0.113.5") true)
        body (get-in doc [:resource :cloudflare_dns_record :langfuse])]
    (is (= "${data.cloudflare_zone.zone.id}" (:zone_id body)))
    (is (= "langfuse.example.com" (:name body)))
    (is (= "203.0.113.5" (:content body)))
    (is (= 1 (:ttl body)))
    (is (true? (:proxied body)))))

(deftest the-ingestion-body-is-one-trace-tagged-for-the-operator-path
  (let [b (json/parse-string (tools/ingestion-body "t-1") true)]
    (is (= 1 (count (:batch b))))
    (is (= "trace-create" (:type (first (:batch b)))))
    (is (= "t-1" (get-in b [:batch 0 :body :id])))))
