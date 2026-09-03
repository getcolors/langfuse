(ns io.github.getcolors.langfuse.workflow-test
  (:require [clojure.test :refer [deftest is testing]]
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

(deftest normalized-params-keep-the-hosts-but-state-output-keeps-once-s-key
  (testing "ONCE reads :ssh_key_id with the underscore from the state map; only
            the host list is renamed into this package's vocabulary"
    (let [raw {:ssh_key_id "k" :hosts [{:role "app" :index nil :ip "1.1.1.1" :vpc_ip "10.0.0.1"}]}
          norm (io.github.getcolors.langfuse.tools/normalize-params raw)]
      (is (= "k" (:ssh_key_id raw)))
      (is (= "k" (:ssh-key-id norm)))
      (is (= "10.0.0.1" (:vpc-ip (first (:hosts norm))))))))
