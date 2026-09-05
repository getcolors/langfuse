(ns io.github.getcolors.langfuse.workflow-test
  (:require [babashka.fs :as fs]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.tofu :as tofu]
            [io.github.getcolors.langfuse.tools :as tools]
            [io.github.getcolors.langfuse.topology :as topology]
            [io.github.getcolors.langfuse.topology-test :refer [params]]
            [io.github.getcolors.langfuse.validate-test :refer [base creds]]
            [io.github.getcolors.langfuse.workflow :as w]))

(defn chain [event]
  (loop [step :langfuse/start acc []]
    (let [[_ & next] (w/wire-fn step {:green/event event})]
      (if (empty? next) (conj acc step) (recur (first next) (conj acc step))))))

(deftest create-converges-in-dependency-order
  (is (= [:langfuse/start :langfuse/infrastructure :langfuse/dns :langfuse/ssh-config
          :langfuse/ansible :langfuse/acceptance]
         (chain :create)))
  (testing "DNS before the converge: Caddy's ACME challenge needs the name to resolve"
    (is (< (.indexOf (chain :create) :langfuse/dns) (.indexOf (chain :create) :langfuse/ansible)))))

(deftest delete-removes-the-config-block-before-and-the-key-after-the-destroy
  (let [c (chain :delete)]
    (is (= [:langfuse/start :langfuse/ansible :langfuse/ssh-config :langfuse/dns
            :langfuse/infrastructure :langfuse/ssh-cleanup] c))
    (is (< (.indexOf c :langfuse/ssh-config) (.indexOf c :langfuse/infrastructure)))
    (is (< (.indexOf c :langfuse/infrastructure) (.indexOf c :langfuse/ssh-cleanup)))))

(deftest rehearse-and-describe-run-against-state
  (is (= [:langfuse/start :langfuse/rehearsal] (chain :rehearse)))
  (is (= [:langfuse/start :langfuse/describe] (chain :describe))))

(deftest every-side-effecting-step-is-dry-run-advised
  (doseq [s [:langfuse/infrastructure :langfuse/dns :langfuse/ssh-config :langfuse/ansible
             :langfuse/acceptance :langfuse/ssh-cleanup :langfuse/rehearsal :langfuse/describe]]
    (is (some #{s} w/side-effecting) (str s " must be dry-run advised"))))

;; --- the legacy state -------------------------------------------------------

;; The shape `langfuse-vultr` recorded before adoption, as `tofu output -json`
;; delivers it to the reader: string keys, `hosts` rather than `nodes`,
;; `index: null` on the four singletons, no `provider`.
(def legacy-raw
  {"ssh_key_id" "7692e92a"
   "hosts" [{"role" "neon" "index" nil "name" "langfuse-vultr-neon" "ip" "203.0.113.1" "vpc_ip" "10.50.0.3" "user" "root" "sudoer" "root"}
            {"role" "redis" "index" nil "name" "langfuse-vultr-redis" "ip" "203.0.113.2" "vpc_ip" "10.50.0.4" "user" "root" "sudoer" "root"}
            {"role" "clickhouse" "index" 0 "name" "langfuse-vultr-clickhouse-0" "ip" "203.0.113.3" "vpc_ip" "10.50.0.5" "user" "root" "sudoer" "root"}
            {"role" "clickhouse" "index" 1 "name" "langfuse-vultr-clickhouse-1" "ip" "203.0.113.4" "vpc_ip" "10.50.0.6" "user" "root" "sudoer" "root"}
            {"role" "clickhouse" "index" 2 "name" "langfuse-vultr-clickhouse-2" "ip" "203.0.113.5" "vpc_ip" "10.50.0.7" "user" "root" "sudoer" "root"}
            {"role" "app" "index" nil "name" "langfuse-vultr-app" "ip" "203.0.113.6" "vpc_ip" "10.50.0.8" "user" "root" "sudoer" "root"}]})

(def legacy-translated
  {:provider "vultr" :ssh_key_id "7692e92a"
   :nodes [{:role "neon" :index 0 :name "langfuse-vultr-neon" :ip "203.0.113.1" :vpc_ip "10.50.0.3" :user "root" :sudoer "root"}
           {:role "redis" :index 0 :name "langfuse-vultr-redis" :ip "203.0.113.2" :vpc_ip "10.50.0.4" :user "root" :sudoer "root"}
           {:role "clickhouse" :index 0 :name "langfuse-vultr-clickhouse-0" :ip "203.0.113.3" :vpc_ip "10.50.0.5" :user "root" :sudoer "root"}
           {:role "clickhouse" :index 1 :name "langfuse-vultr-clickhouse-1" :ip "203.0.113.4" :vpc_ip "10.50.0.6" :user "root" :sudoer "root"}
           {:role "clickhouse" :index 2 :name "langfuse-vultr-clickhouse-2" :ip "203.0.113.5" :vpc_ip "10.50.0.7" :user "root" :sudoer "root"}
           {:role "app" :index 0 :name "langfuse-vultr-app" :ip "203.0.113.6" :vpc_ip "10.50.0.8" :user "root" :sudoer "root"}]})

(deftest the-reader-translates-the-pre-adoption-hosts-into-nodes
  ;; `hosts` becomes `nodes`, a singleton's null index becomes 0, the provider
  ;; is the only one this package ever offered, and everything else — the
  ;; replica ordinals, every name and address, `ssh_key_id` — is untouched.
  (is (= legacy-translated (w/legacy-params (clojure.walk/keywordize-keys legacy-raw))))
  (testing "a params that already carries nodes passes through"
    (is (= params (w/legacy-params params)))
    (is (= (dissoc params :provider) (w/legacy-params (dissoc params :provider)))))
  (testing "nothing here checks cardinality; that is ONCE's, through adopt-state"
    (is (= 5 (count (:nodes (w/legacy-params {:hosts (vec (butlast (get (clojure.walk/keywordize-keys legacy-raw) :hosts)))}))))))
  (testing "the real reader runs the translation on what tofu delivers"
    (with-redefs [tofu/outputs (fn [_ _] {:params legacy-raw})]
      (is (= legacy-translated (w/state-output base))))
    (with-redefs [tofu/outputs (fn [_ _] {})]
      (is (nil? (w/state-output base))))))

;; --- the lifecycle against the compute state --------------------------------

;; The compute state is read once per run, through `w/state-output`, on a real
;; create, delete, rehearse or describe. Every lifecycle test stubs it: nil is
;; a readable state holding no compute, a map is a recorded `params`, and a
;; throw is a backend that cannot be read.
(defn- start [opts state]
  (with-redefs [w/state-output (fn [_] state)]
    (w/start-step opts {})))

(defn- start-recorded
  "The real reader over a stubbed `tofu output -json`, so the legacy
  translation is on the path."
  [opts raw]
  (with-redefs [tofu/outputs (fn [_ _] {:params raw})]
    (w/start-step opts {})))

(defn- start-unreadable [opts]
  ;; The shape `green.tofu/outputs` throws: an ex-info carrying `:dir`. Only
  ;; that is an unreadable backend; anything else propagates as a defect.
  (with-redefs [w/state-output (fn [_] (throw (ex-info "tofu output failed: no backend" {:dir "x"})))]
    (w/start-step opts {})))

(def deleting (merge base creds {:green/event :delete :compute-prevent-destroy false}))

(deftest build-and-dry-run-never-touch-the-state
  ;; A throwing state read proves nothing on these paths reaches the backend,
  ;; and the machine key stays the placeholder rather than the operator's home.
  (doseq [opts [(assoc base :green/event :build)
                (assoc base :green/event :create :green/dry-run true)
                (assoc base :green/event :delete :green/dry-run true :compute-prevent-destroy false)
                (assoc base :green/event :rehearse :green/dry-run true)
                (assoc base :green/event :describe :green/dry-run true)]]
    (let [result (start-unreadable opts)]
      (is (= 0 (:green/exit result)) (:green/err result))
      (is (str/starts-with? (str (:ssh-public-key-path result)) "/home/build-placeholder"))
      (is (nil? (:once/cluster result)) "a build renders the fallbacks, it adopts nothing"))))

(deftest a-real-create-requires-the-credentials
  (let [r (start (assoc base :green/event :create) nil)]
    (is (= 2 (:green/exit r)))
    (is (str/includes? (:green/err r) "COLORS_PAR_VULTR_API_KEY"))
    (is (str/includes? (:green/err r) "COLORS_PAR_CLOUDFLARE_API_TOKEN"))
    (is (str/includes? (:green/err r) "COLORS_PAR_LANGFUSE_ENCRYPTION_KEY"))))

(deftest a-provider-switch-is-refused-before-the-credentials
  ;; Provider switching is a rebuild, never an apply. The validator order is
  ;; the thing under test: the actionable error, not a missing token for the
  ;; provider that was just selected.
  (doseq [event [:create :delete]]
    (let [r (start (assoc base :green/event event :compute-prevent-destroy false)
                   (assoc params :provider "digitalocean"))]
      (is (= 2 (:green/exit r)) (name event))
      (is (str/includes? (:green/err r)
                         "state holds a digitalocean machine; set provider-compute back to digitalocean and delete first"))
      (is (not (str/includes? (:green/err r) "required credential is not set"))))))

(deftest legacy-state-is-accepted-on-the-default-provider
  ;; A `params` without `provider` is a Vultr cluster: a create checks its
  ;; credentials as usual, a delete adopts it.
  (let [legacy (dissoc params :provider)]
    (let [r (start (assoc base :green/event :create) legacy)]
      (is (not (str/includes? (:green/err r) "state holds")))
      (is (str/includes? (:green/err r) "required credential is not set")))
    (let [r (start deleting legacy)]
      (is (= 0 (:green/exit r)) (:green/err r))
      (is (= legacy (:once/cluster r))))))

(deftest a-real-delete-adopts-the-live-deployments-pre-adoption-state
  ;; The recorded shape of langfuse-vultr, through the real reader: six hosts
  ;; under `hosts`, the singletons with `index: null`. The delete addresses
  ;; every machine the deployment ever created.
  (let [r (start-recorded deleting legacy-raw)]
    (is (= 0 (:green/exit r)) (:green/err r))
    (is (= legacy-translated (:once/cluster r)))
    (let [hs (tools/hosts r)]
      (is (= ["203.0.113.1" "203.0.113.2" "203.0.113.3" "203.0.113.4" "203.0.113.5" "203.0.113.6"]
             (mapv :ip hs)))
      (is (= "10.50.0.8" (:vpc-ip (topology/host-of hs :app))))
      (is (= "langfuse-vultr-clickhouse-1" (:name (topology/host-of hs :clickhouse 1))))))
  (testing "rehearse and describe adopt it the same way"
    (doseq [event [:rehearse :describe]]
      (let [r (start-recorded (assoc base :green/event event) legacy-raw)]
        (is (= 0 (:green/exit r)) (:green/err r))
        (is (= legacy-translated (:once/cluster r))))))
  (testing "a hosts list that does not describe every machine is refused by ONCE, not guessed"
    (let [five (update legacy-raw "hosts" #(vec (remove (fn [h] (= "app" (get h "role"))) %)))
          r (start-recorded deleting five)]
      (is (= 1 (:green/exit r)))
      (is (= "the compute stage did not report nodes this package declares: app-0" (:green/err r))))))

(deftest an-unreadable-backend-counts-as-no-state-on-create
  ;; A fresh clone has no readable state and must still be able to create.
  (let [r (start-unreadable (assoc base :green/event :create))]
    (is (= 2 (:green/exit r)))
    (is (not (str/includes? (:green/err r) "could not read")))
    (is (not (str/includes? (:green/err r) "state holds")))
    (is (str/includes? (:green/err r) "COLORS_PAR_VULTR_API_KEY"))))

(deftest a-real-create-on-a-fresh-work-directory-reports-the-credentials-not-a-crash
  ;; No state stub: the real `state-output` runs against a work directory that
  ;; holds no stage yet, as a fresh clone's does. Green's SDK shells out to
  ;; tofu in a directory that does not exist and reports that launch failure
  ;; as its own `tofu output failed:` step error; ONCE's `read-state` counts
  ;; that as an unreadable state, so the create reports its credentials
  ;; instead of crashing.
  (let [work (str (fs/create-temp-dir {:prefix "langfuse-fresh"}))]
    (try
      (let [r (w/start-step (assoc base :workdir work :green/event :create) {})]
        (is (= 2 (:green/exit r)))
        (is (str/includes? (str (:green/err r)) "COLORS_PAR_VULTR_API_KEY"))
        (is (not (str/includes? (str (:green/err r)) "could not read"))))
      (finally (fs/delete-tree work)))))

(deftest an-unreadable-backend-fails-a-real-delete-rehearse-and-describe-closed
  ;; Before adoption every one of these swallowed the read and went on: a
  ;; delete would have rendered the cleanup play against the documentation
  ;; addresses, and rehearse and describe reported "no compute in state" for
  ;; a backend they merely could not reach.
  (let [r (start-unreadable deleting)]
    (is (= 1 (:green/exit r)))
    (is (str/includes? (:green/err r) "could not read the infrastructure state for the delete cleanup"))
    (is (str/includes? (:green/err r) "no backend")))
  (doseq [event [:rehearse :describe]]
    (let [r (start-unreadable (assoc base :green/event event))]
      (is (= 1 (:green/exit r)) (name event))
      (is (str/includes? (:green/err r) (str "could not read the infrastructure state for " (name event))))
      (is (not (str/includes? (:green/err r) "no compute in state"))))))

(deftest a-real-delete-adopts-the-recorded-cluster
  (let [r (start deleting params)]
    (is (= 0 (:green/exit r)) (:green/err r))
    (is (= params (:once/cluster r)) "the whole recorded params, extension keys and all")
    (is (= ["1.1.1.1" "1.1.1.2" "1.1.1.3" "1.1.1.4" "1.1.1.5" "1.1.1.6"] (mapv :ip (tools/hosts r)))))
  (testing "a readable state without compute adopts nothing, and the cleanup play skips itself"
    (let [r (start deleting nil)]
      (is (= 0 (:green/exit r)) (:green/err r))
      (is (not (contains? r :once/cluster)))))
  (testing "rehearse and describe need a recorded cluster"
    (doseq [event [:rehearse :describe]]
      (let [r (start (assoc base :green/event event) nil)]
        (is (= 1 (:green/exit r)))
        (is (= (str (name event) ": no compute in state; run create first") (:green/err r))))
      (let [r (start (assoc base :green/event event) params)]
        (is (= 0 (:green/exit r)) (:green/err r))
        (is (= params (:once/cluster r)))))))

(deftest a-real-delete-refuses-a-state-that-does-not-describe-every-machine
  ;; Six machines are declared; a state that reports five is not a smaller
  ;; deployment to tear down but a state that cannot be trusted. ONCE's
  ;; message, unreworded.
  (let [r (start deleting (update params :nodes pop))]
    (is (= 1 (:green/exit r)))
    (is (= "the compute stage did not report nodes this package declares: app-0" (:green/err r))))
  (testing "a machine without an address is refused the same way"
    (let [r (start deleting (assoc-in params [:nodes 3 :vpc_ip] ""))]
      (is (= 1 (:green/exit r)))
      (is (str/includes? (:green/err r) "did not report a complete node (ip, vpc_ip, name, user, sudoer) for clickhouse-1"))))
  (testing "a legacy index: null that was not translated is an undeclared id"
    (let [r (start deleting (assoc-in params [:nodes 5 :index] nil))]
      (is (= 1 (:green/exit r)))
      (is (str/includes? (:green/err r) "did not report nodes this package declares: app-0"))
      (is (str/includes? (:green/err r) "reported nodes this package does not declare: app-null")))))
