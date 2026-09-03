(ns io.github.getcolors.langfuse.workflow
  (:require [green.cli :as green-cli]
            [green.dry-run :as dry-run]
            [green.lifecycle :as lifecycle]
            [green.progress :as progress]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.langfuse.ssh :as ssh]
            [io.github.getcolors.langfuse.ssh-config :as ssh-config]
            [io.github.getcolors.langfuse.tools :as tools]
            [io.github.getcolors.langfuse.validate :as validate]))

(def defaults {:provider-compute "vultr" :provider-dns "cloudflare"
               :provider-backend "local" :compute-prevent-destroy true
               :workdir ".colors"})

(defn state-output
  "The compute stage's applied `params`, or nil when no state is readable. The
  create matrix keys on this best-effort read: an unreadable state (a fresh
  clone, a missing backend) counts as absent."
  [opts]
  (try (some-> (tofu/outputs (tools/tool-dir opts tools/infrastructure-tool)
                             (tools/backend-credential-env opts))
               :params tools/normalize-params)
       (catch Exception _ nil)))

(defn- with-state-hosts
  "Events that run against existing machines (delete, rehearse, describe)
  take their addresses from state rather than from a fresh apply."
  [opts]
  (let [params (state-output opts)]
    (cond-> opts
      (seq (:hosts params)) (assoc :langfuse/hosts (:hosts params)
                                   :langfuse/ssh-key-id (:ssh-key-id params)))))

(defn start-step
  ([opts] (start-step opts (System/getenv)))
  ([opts env]
   (lifecycle/preflight
    opts {:defaults defaults :overlay green-cli/read-pars
          :validators
          [(fn [_ env _] (validate/env-errors env))
           (fn [opts _ _] (validate/state-errors opts))
           (fn [opts _ {:keys [event real?]}]
             (when (and real? (contains? #{:create :delete} event))
               (validate/secret-errors opts event)))
           (fn [opts _ {:keys [event real?]}]
             (when (and real? (= :delete event) (:compute-prevent-destroy opts))
               [(str "compute destruction is protected; set "
                     (green-cli/par-name :compute-prevent-destroy) "=false to delete")]))]
          :after-validate
          ;; The machine key's create matrix and the Vultr preflight run before
          ;; any template is rendered: an unowned key on disk or at the provider
          ;; stops the run while stopping is still free.
          (fn [opts _ {:keys [event real?]}]
            (cond
              (and real? (= :delete event))
              (merge (with-state-hosts (ssh/with-machine-key opts)) {:green/exit 0})

              (and real? (contains? #{:rehearse :describe} event))
              (let [opts (with-state-hosts (ssh/with-machine-key opts))]
                (if (empty? (:langfuse/hosts opts))
                  (assoc opts :green/exit 1
                         :green/err (str (name event) ": no compute in state; run create first"))
                  (assoc opts :green/exit 0)))

              (and real? (= :create event))
              (let [opts (ssh/ensure-key! opts state-output)]
                (if (wf/failed? opts)
                  opts
                  (let [opts (ssh/preflight! (ssh/with-machine-key opts))
                        opts (if (wf/failed? opts) opts (ssh-config/preflight! opts))]
                    (if (wf/failed? opts) opts (assoc opts :green/exit 0)))))

              :else
              (assoc (ssh/with-machine-key opts) :green/exit 0)))} env)))

(defn wire-fn [step run-opts]
  (case (:green/event run-opts)
    :delete
    (case step
      :langfuse/start [start-step :langfuse/ansible]
      :langfuse/ansible [tools/ansible-step :langfuse/ssh-config]
      ;; The `~/.ssh/config` block goes before the destroy, the opposite of the
      ;; keypair below. A block that outlives its hosts is stale but harmless;
      ;; a key that predeceases them locks the operator out of machines that
      ;; still exist. Both orders are deliberate; see standards/ssh-config.md.
      :langfuse/ssh-config [tools/ansible-local-step :langfuse/dns]
      ;; DNS before the compute destroy: a record pointing at a released
      ;; address is worse than no record.
      :langfuse/dns [tools/dns-step :langfuse/infrastructure]
      :langfuse/infrastructure [tools/infrastructure-step :langfuse/ssh-cleanup]
      :langfuse/ssh-cleanup [ssh/cleanup-step])

    :rehearse
    (case step
      :langfuse/start [start-step :langfuse/rehearsal]
      :langfuse/rehearsal [tools/rehearsal-step])

    :describe
    (case step
      :langfuse/start [start-step :langfuse/describe]
      :langfuse/describe [tools/describe-step])

    (case step
      :langfuse/start [start-step :langfuse/infrastructure]
      ;; After compute, which is where the addresses first exist, and before
      ;; the stage that converges the machines — the converge and the
      ;; acceptance both ride the aliases this stage writes.
      :langfuse/infrastructure [tools/infrastructure-step :langfuse/dns]
      ;; DNS before the converge: Caddy provisions its certificate over ACME
      ;; on first start, and the HTTP-01 challenge needs the name to already
      ;; resolve to the app host.
      :langfuse/dns [tools/dns-step :langfuse/ssh-config]
      :langfuse/ssh-config [tools/ansible-local-step :langfuse/ansible]
      :langfuse/ansible [tools/ansible-step :langfuse/acceptance]
      :langfuse/acceptance [tools/acceptance-step])))

(defn backend-advice [tool]
  (tofu/conventional-backend-advice
   {:dir-fn #(tools/tool-dir % tool)
    :key-fn #(str (:profile %) "/" tool ".tfstate")}))

(def side-effecting
  [:langfuse/infrastructure :langfuse/dns :langfuse/ssh-config
   :langfuse/ansible :langfuse/acceptance :langfuse/ssh-cleanup
   :langfuse/rehearsal :langfuse/describe])

(def workflow
  (-> (wf/workflow {:start :langfuse/start :wire-fn wire-fn})
      (wf/advice-add :langfuse/infrastructure :before ::backend
                     (backend-advice tools/infrastructure-tool))
      (wf/advice-add :langfuse/dns :before ::backend (backend-advice tools/dns-tool))
      progress/advise
      (dry-run/advise side-effecting)))
