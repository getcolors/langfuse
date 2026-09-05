(ns io.github.getcolors.langfuse.tools-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [cheshire.core :as json]
            [io.github.getcolors.langfuse.tools :as tools]
            [io.github.getcolors.langfuse.topology :as topology]
            [io.github.getcolors.langfuse.topology-test :refer [params]]))

(def opts {:profile "langfuse-test" :provider-compute "vultr" :vultr-vpc-subnet "10.50.0.0/24"
           :langfuse-host "langfuse.example.com" :cloudflare-proxied true})

(def applied (assoc opts :once/cluster params))

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

(deftest the-adopted-cluster-reaches-the-renderers-respelled
  ;; ONCE records `vpc_ip` and `ssh_key_id` with underscores — the latter is
  ;; the SSH Keypair Standard's contract with ONCE's create preflight and must
  ;; stay verbatim on the params map. The renderers read `:vpc-ip`, so the
  ;; host wrapper respells that one key, and the inventory gets exactly the
  ;; bytes it got before adoption: an ordinal for the replicas alone.
  (let [hs (tools/hosts applied)
        inv (json/parse-string (tools/inventory applied hs) true)
        groups (get-in inv [:all :children])]
    (is (= "7692e92a" (:ssh_key_id (:once/cluster applied))))
    (is (= "10.50.0.2" (:vpc-ip (first hs))))
    (is (not-any? #(contains? % :vpc_ip) hs))
    (is (= "10.50.0.7" (get-in groups [:app :hosts :langfuse-test-app :vpc_ip])))
    (is (nil? (get-in groups [:app :hosts :langfuse-test-app :ordinal])))
    (is (= 2 (get-in groups [:clickhouse :hosts :langfuse-test-clickhouse-2 :ordinal])))))

(deftest the-compute-stage-refuses-anything-but-the-whole-cluster
  ;; The real create's infrastructure step hands its tofu outputs here. No
  ;; `params` output at all, or a machine set that is partial or incomplete,
  ;; is exit 1 with ONCE's message rather than a ClickHouse cluster config
  ;; against 192.0.2.20; the whole cluster lands under `:once/cluster`.
  (let [result (fn [p] {:green/exit 0 :tofu/outputs (when p {:params p})})]
    (testing "no params output"
      (let [r (tools/resolved-cluster opts (result nil))]
        (is (= 1 (:green/exit r)))
        (is (= "compute produced no params output; refusing to converge against the documentation addresses"
               (:green/err r)))))
    (testing "a partial cluster: two replicas form no quorum"
      (let [r (tools/resolved-cluster opts (result (update params :nodes #(vec (remove (fn [n] (and (= "clickhouse" (:role n)) (= 2 (:index n)))) %)))))]
        (is (= 1 (:green/exit r)))
        (is (= "the compute stage did not report nodes this package declares: clickhouse-2" (:green/err r)))))
    (testing "an incomplete node"
      (let [r (tools/resolved-cluster opts (result (assoc-in params [:nodes 5 :vpc_ip] "")))]
        (is (= 1 (:green/exit r)))
        (is (str/includes? (:green/err r) "did not report a complete node (ip, vpc_ip, name, user, sudoer) for app-0"))))
    (testing "the whole cluster, string-keyed as tofu delivers it"
      (let [raw {"provider" "vultr" "ssh_key_id" "7692e92a"
                 "nodes" (mapv #(into {} (map (fn [[k v]] [(name k) v])) %) (:nodes params))}
            r (tools/resolved-cluster opts (result raw))]
        (is (= 0 (:green/exit r)))
        (is (= params (:once/cluster r)))))))

(deftest the-ssh-config-block-carries-the-profile-first
  (let [hs (tools/ssh-config-hosts opts (topology/hosts opts))]
    (is (= "langfuse-test" (:name (first hs))))
    (is (= (:ip (topology/host-of (topology/hosts opts) :app)) (:ip (first hs))))
    (is (= 7 (count hs)))
    (is (= ["langfuse-test" "langfuse-test-neon" "langfuse-test-redis"
            "langfuse-test-clickhouse-0" "langfuse-test-clickhouse-1" "langfuse-test-clickhouse-2"
            "langfuse-test-app"]
           (mapv :name hs)))
    (is (= ["192.0.2.12" "192.0.2.10" "192.0.2.11" "192.0.2.20" "192.0.2.21" "192.0.2.22" "192.0.2.12"]
           (mapv :ip hs))))
  (testing "on a real run the addresses are the recorded ones"
    (is (= ["1.1.1.6" "1.1.1.1" "1.1.1.2" "1.1.1.3" "1.1.1.4" "1.1.1.5" "1.1.1.6"]
           (mapv :ip (tools/ssh-config-hosts applied (tools/hosts applied)))))))

(deftest a-delete-with-no-compute-in-state-stops-instead-of-converging
  ;; A readable state without compute adopted nothing: there is nothing to
  ;; stop, and the cleanup play would only fail against the placeholder
  ;; addresses.
  (is (= 0 (:green/exit (tools/ansible-step (assoc opts :green/event :delete))))))

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

(deftest the-operator-path-ingests-one-otlp-root-span
  (testing "v4 ingestion is OTLP: one root span, 32-hex trace id, tagged so the
            read-back can find it; the legacy batch endpoint rejects everything"
    (let [t (tools/hex-id 16) s (tools/hex-id 8)
          b (json/parse-string (tools/otlp-body t s) true)
          span (get-in b [:resourceSpans 0 :scopeSpans 0 :spans 0])]
      (is (re-matches #"[0-9a-f]{32}" t))
      (is (re-matches #"[0-9a-f]{16}" s))
      (is (= t (:traceId span)))
      (is (some #(= "langfuse.trace.tags" (:key %)) (:attributes span)))
      (is (= "span" (get-in (first (filter #(= "langfuse.observation.type" (:key %)) (:attributes span))) [:value :stringValue]))))))

(deftest observation-rows-are-counted-defensively
  (is (= 2 (tools/observations-count {:out "{\"data\":[{},{}]}\n200"})))
  (is (= 0 (tools/observations-count {:out "not json\n502"}))))
