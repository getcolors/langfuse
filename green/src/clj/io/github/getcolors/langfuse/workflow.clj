(ns io.github.getcolors.langfuse.workflow
  (:require [clojure.walk :as walk]
            [green.cli :as green-cli]
            [green.dry-run :as dry-run]
            [green.lifecycle :as lifecycle]
            [green.progress :as progress]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.langfuse.ssh :as ssh]
            [io.github.getcolors.langfuse.ssh-config :as ssh-config]
            [io.github.getcolors.langfuse.tools :as tools]
            [io.github.getcolors.langfuse.validate :as validate]
            [io.github.getcolors.once.compute :as compute]
            [io.github.getcolors.once.compute-cluster :as once-cluster]))

(def defaults {:provider-compute validate/default-compute-provider :provider-dns "cloudflare"
               :provider-backend "local" :compute-prevent-destroy true
               :workdir ".colors"})

(defn legacy-params
  "The recorded `params` in the Compute Cluster Standard's shape.

  A state written before this package adopted the standard — `langfuse-vultr`'s
  is one — recorded its machines under `hosts`, with `index: null` on the
  four singletons and no `provider`. ONCE reads exactly `provider`,
  `ssh_key_id` and `nodes`, and refuses `index: null` as an id this package
  does not declare, so the translation happens here, before ONCE sees the
  state: `hosts` becomes `nodes`, every null index becomes 0 (a singleton is
  node 0 of its role; the replicas already carry their ordinal), and the
  provider is the only one this package ever offered. Roles, names and
  addresses are untouched, and so is everything else in the map —
  `ssh_key_id` above all, which the SSH Keypair Standard's create matrix reads
  verbatim. A `params` that already carries `nodes` passes through. Nothing
  here checks cardinality: a `hosts` list that does not describe every
  machine is ONCE's `node-errors` to refuse, through `adopt-state`."
  [params]
  (if (and (contains? params :hosts) (not (contains? params :nodes)))
    (-> params
        (dissoc :hosts)
        (assoc :provider validate/default-compute-provider
               :nodes (mapv (fn [h] (assoc h :index (or (:index h) 0))) (:hosts params))))
    params))

(defn state-output
  "The reader ONCE's `read-state` takes: the recorded `params` map,
  keywordized with the underscores kept (`:ssh_key_id`, `:vpc_ip`) and
  translated from the pre-adoption `hosts` shape by `legacy-params`, or nil
  when the state is readable and holds no compute. An unreadable backend is
  whatever `green.tofu/outputs` throws, deliberately uncaught: `read-state`
  turns the SDK's step error into `{:error message}`, and create treats that
  differently from delete, rehearse and describe. Kept local so tests can
  redefine it."
  [opts]
  (some-> (tofu/outputs (tools/tool-dir opts tools/infrastructure-tool)
                        (tools/backend-credential-env opts))
          :params walk/keywordize-keys legacy-params))

(def state-events
  "The events that run against the recorded cluster and adopt it from state:
  delete, rehearse and describe. Create reads the state too, for the SSH
  Keypair Standard's create matrix and the provider switch guard, but takes
  its cluster from the fresh apply."
  #{:delete :rehearse :describe})

(defn start-step
  ([opts] (start-step opts (System/getenv)))
  ([opts env]
   ;; The state is read once, up front, on the same defaulted and overlaid
   ;; opts the validators see — the overlay is what carries the backend
   ;; credentials — and only for the events that touch a provider or the
   ;; recorded cluster. The validator and the after-validate share the one
   ;; read.
   (let [overlaid (green-cli/read-pars (merge defaults opts) env)
         context {:event (:green/event overlaid) :real? (lifecycle/real-run? overlaid)}
         state (when (or (compute/lifecycle-event? context)
                         (and (:real? context) (contains? state-events (:event context))))
                 (once-cluster/read-state overlaid state-output))]
     (lifecycle/preflight
      opts {:defaults defaults :overlay green-cli/read-pars
            :validators
            [(fn [_ env _] (validate/env-errors env))
             (fn [opts _ _] (validate/state-errors opts))
             ;; Compute Provider Standard §4 before the credentials: a recorded
             ;; provider that differs from the selected one reports the
             ;; actionable error, not a missing token for the provider that was
             ;; just selected.
             (fn [opts _ {:keys [event] :as ctx}]
               (when (compute/lifecycle-event? ctx)
                 (once-cluster/provider-validator validate/spec opts (:params state)
                                                  #(validate/secret-errors opts event))))
             (fn [opts _ {:keys [event real?]}]
               (when (and real? (= :delete event) (:compute-prevent-destroy opts))
                 [(str "compute destruction is protected; set "
                       (green-cli/par-name :compute-prevent-destroy) "=false to delete")]))]
            :after-validate
            ;; The machine key's create matrix and the Vultr preflight run before
            ;; any template is rendered: an unowned key on disk or at the provider
            ;; stops the run while stopping is still free. Delete, rehearse and
            ;; describe adopt the recorded cluster under `:once/cluster` instead,
            ;; failing closed on a backend they cannot read and on a state that
            ;; does not describe every machine.
            (fn [opts _ {:keys [event real?]}]
              (cond
                (and real? (= :delete event))
                (once-cluster/adopt-state validate/spec opts :delete state)

                (and real? (contains? #{:rehearse :describe} event))
                (let [opts (once-cluster/adopt-state validate/spec opts event state)]
                  (if (and (not (wf/failed? opts)) (nil? (:once/cluster opts)))
                    ;; Readable, and nothing recorded: there is nothing to
                    ;; rehearse against or describe.
                    (assoc opts :green/exit 1
                           :green/err (str (name event) ": no compute in state; run create first"))
                    opts))

                (and real? (= :create event))
                (let [opts (ssh/ensure-key! opts (fn [_] (:params state)))]
                  (if (wf/failed? opts)
                    opts
                    (let [opts (ssh/preflight! (ssh/with-machine-key opts))
                          opts (if (wf/failed? opts) opts (ssh-config/preflight! opts))]
                      (if (wf/failed? opts) opts (assoc opts :green/exit 0)))))

                :else
                (assoc (ssh/with-machine-key opts) :green/exit 0)))} env))))

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
