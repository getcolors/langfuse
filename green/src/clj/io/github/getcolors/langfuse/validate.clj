(ns io.github.getcolors.langfuse.validate
  (:require [clojure.string :as str]
            [green.cli :as green-cli]
            [io.github.getcolors.once.ssh :as once-ssh]
            [io.github.getcolors.once.validate :as once-validate]
            [io.github.getcolors.langfuse.topology :as topology]))

(def profile-par (green-cli/par-name :profile))

(def required
  "Every key desired state must carry.

  Two deliberate absences carried over from `neon`: `vultr-ssh-keys` selects
  opt-out mode by being present (SSH Keypair Standard), so requiring it would
  make every conforming keygen deployment invalid, and `vultr-name` is the
  Compute Name Standard's optional override. `r2-credential-sharing` is
  likewise optional: its presence is the opt-out."
  [:profile :workdir :provider-compute :provider-dns :provider-backend
   :compute-prevent-destroy
   ;; application tier
   :langfuse-image :langfuse-worker-image :langfuse-host
   :langfuse-init-org-id :langfuse-init-org-name
   :langfuse-init-project-id :langfuse-init-project-name
   :langfuse-init-user-email :langfuse-init-user-name
   :langfuse-s3-bucket :langfuse-s3-prefix
   :langfuse-smoke-traces :langfuse-smoke-timeout-seconds
   :caddy-image
   ;; cache tier
   :redis-image :redis-port
   ;; analytics tier
   :clickhouse-version :clickhouse-cluster-name :clickhouse-nodes
   :clickhouse-http-port :clickhouse-native-port :clickhouse-interserver-port
   :clickhouse-keeper-port :clickhouse-raft-port
   ;; storage tier — neon's own vocabulary, because this package renders
   ;; neon's templates rather than copying them (see deps.edn)
   :neon-image :neon-compute-image :neon-pg-version
   :neon-tenant-id :neon-timeline-id
   :neon-database :neon-role
   :neon-r2-bucket :neon-r2-endpoint :neon-r2-region :neon-r2-prefix
   ;; backups
   :langfuse-backup-r2-bucket :langfuse-backup-r2-endpoint :langfuse-backup-r2-region
   :langfuse-postgres-backup-oncalendar :langfuse-clickhouse-backup-oncalendar
   :langfuse-media-backup-oncalendar :langfuse-backup-retention-days
   :langfuse-postgres-backup-max-age-hours :langfuse-clickhouse-backup-max-age-hours
   :langfuse-media-backup-max-age-hours
   ;; public name and TLS
   :cloudflare-zone :cloudflare-record-name :cloudflare-proxied
   ;; compute
   :vultr-region :vultr-os-id :vultr-vpc-subnet
   :vultr-plan-neon :vultr-plan-redis :vultr-plan-clickhouse :vultr-plan-app
   :vultr-ssh-sources :vultr-http-sources
   :r2-bucket :r2-endpoint])

(def image-keys [:langfuse-image :langfuse-worker-image :caddy-image :redis-image
                 :neon-image :neon-compute-image])

(def image-re #"^[^\s:@]+(?:/[^\s:@]+)*(?::[^\s:@]+|@sha256:[0-9a-f]{64}|:[^\s:@]+@sha256:[0-9a-f]{64})$")
(def hex32-re #"^[0-9a-f]{32}$")
(def hex64-re #"^[0-9a-f]{64}$")
(def ident-re #"^[a-z_][a-z0-9_]*$")
(def slug-re #"^[a-z0-9][a-z0-9-]*$")
(def url-re #"^https://[^\s]+$")
(def host-re #"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$")
(def email-re #"^[^@\s]+@[^@\s]+\.[^@\s]+$")
(def cidr-v4-re #"^(\d{1,3}\.){3}\d{1,3}/\d{1,2}$")
(def clickhouse-version-re #"^(\d+)\.(\d+)\.\d+\.\d+$")
(def version-tag-re #":([^\s:@/]+)@sha256:")

(defn missing? [x] (or (nil? x) (and (string? x) (str/blank? x))))

(defn compute-name [opts] (topology/compute-name opts))
(defn keygen? [opts] (once-ssh/keygen? opts))

(defn image-version
  "The human-readable tag out of a `repo:tag@sha256:...` pin, or nil."
  [v]
  (second (re-find version-tag-re (str v))))

(defn credential-sharing-accepted?
  "Whether desired state explicitly accepts one R2 credential reaching
  OpenTofu state and live data or backups alike."
  [opts]
  (= "shared-accepted" (str (:r2-credential-sharing opts))))

(defn env-errors [env]
  (when (not-empty (str (get env profile-par)))
    [(str profile-par " is set; profile must come from colors.yml only")]))

(defn- int-like? [v] (or (integer? v) (and (string? v) (re-matches #"^-?\d+$" v))))
(defn- as-int [v] (when (int-like? v) (if (integer? v) v (Long/parseLong v))))

(defn- clickhouse-version-ok?
  "Langfuse v4 requires ClickHouse >= 25.12."
  [v]
  (when-let [[_ major minor] (re-matches clickhouse-version-re (str v))]
    (let [major (Long/parseLong major) minor (Long/parseLong minor)]
      (or (> major 25) (and (= major 25) (>= minor 12))))))

(defn state-errors [opts]
  (vec
   (concat
    (for [k required :when (missing? (get opts k))] (str k " is required"))

    (when-not (= "vultr" (:provider-compute opts))
      [":provider-compute must be vultr"])
    (when-not (= "cloudflare" (:provider-dns opts))
      [":provider-dns must be cloudflare"])
    (when-not (contains? #{"local" "s3" "r2"} (:provider-backend opts))
      [":provider-backend must be local, s3, or r2"])
    (when-not (boolean? (:compute-prevent-destroy opts))
      [":compute-prevent-destroy must be true or false"])

    ;; --- images ------------------------------------------------------------
    (for [k image-keys
          :let [v (get opts k)]
          :when (and (not (missing? v)) (not (re-matches image-re (str v))))]
      (str k " must carry an explicit image tag or digest"))
    (for [k image-keys
          :let [v (str (get opts k))]
          :when (and (not (missing? (get opts k)))
                     (not (str/includes? v "@sha256:")))]
      (str k " must be pinned by digest (tag@sha256:...)"))
    ;; Web and worker ship together; a mismatched pair runs one schema
    ;; against another's migrations.
    (let [a (image-version (:langfuse-image opts))
          b (image-version (:langfuse-worker-image opts))]
      (when (and a b (not= a b))
        [(str ":langfuse-worker-image version " b " must equal :langfuse-image version " a)]))

    ;; --- application tier ---------------------------------------------------
    (when-not (or (missing? (:langfuse-host opts))
                  (re-matches host-re (str (:langfuse-host opts))))
      [":langfuse-host must be a fully qualified hostname"])
    (when-not (or (missing? (:langfuse-init-user-email opts))
                  (re-matches email-re (str (:langfuse-init-user-email opts))))
      [":langfuse-init-user-email must be an email address"])
    (for [k [:langfuse-init-org-id :langfuse-init-project-id]
          :let [v (get opts k)]
          :when (and (not (missing? v)) (not (re-matches slug-re (str v))))]
      (str k " must be a lowercase slug"))
    ;; Langfuse requires a trailing slash on every S3 prefix, and silently
    ;; concatenates without one.
    (when (and (not (missing? (:langfuse-s3-prefix opts)))
               (not (str/ends-with? (str (:langfuse-s3-prefix opts)) "/")))
      [":langfuse-s3-prefix must end with a slash"])
    (when-not (or (missing? (:langfuse-smoke-traces opts))
                  (when-let [n (as-int (:langfuse-smoke-traces opts))] (pos? n)))
      [":langfuse-smoke-traces must be a positive integer"])
    (when-not (or (missing? (:langfuse-smoke-timeout-seconds opts))
                  (when-let [n (as-int (:langfuse-smoke-timeout-seconds opts))] (pos? n)))
      [":langfuse-smoke-timeout-seconds must be a positive integer"])

    ;; --- cache tier -----------------------------------------------------------
    (when-not (or (missing? (:redis-port opts)) (int-like? (:redis-port opts)))
      [":redis-port must be a port number"])

    ;; --- analytics tier -------------------------------------------------------
    (when (and (not (missing? (:clickhouse-version opts)))
               (not (re-matches clickhouse-version-re (str (:clickhouse-version opts)))))
      [":clickhouse-version must be an exact four-part apt version, e.g. 26.3.29.7"])
    (when (and (re-matches clickhouse-version-re (str (:clickhouse-version opts)))
               (not (clickhouse-version-ok? (:clickhouse-version opts))))
      [":clickhouse-version must be 25.12 or newer; Langfuse v4 requires it for lightweight updates, the JSON type, and full-text search"])
    ;; Langfuse's bundled migrations run ON CLUSTER `default`; any other name
    ;; means disabling auto-migration and applying them by hand.
    (when (and (not (missing? (:clickhouse-cluster-name opts)))
               (not= "default" (str (:clickhouse-cluster-name opts))))
      [":clickhouse-cluster-name must be default, or Langfuse cannot run its ON CLUSTER migrations unaided"])
    (when (and (not (missing? (:clickhouse-nodes opts)))
               (not= topology/clickhouse-node-count (as-int (:clickhouse-nodes opts))))
      [(str ":clickhouse-nodes must be " topology/clickhouse-node-count
            " (one shard, three replicas, three Keeper voters)")])
    (for [k [:clickhouse-http-port :clickhouse-native-port :clickhouse-interserver-port
             :clickhouse-keeper-port :clickhouse-raft-port]
          :when (and (not (missing? (get opts k))) (not (int-like? (get opts k))))]
      (str k " must be a port number"))

    ;; --- storage tier -------------------------------------------------------
    (when-not (or (missing? (:neon-pg-version opts))
                  (contains? #{14 15 16 17} (:neon-pg-version opts)))
      [":neon-pg-version must be 14, 15, 16, or 17"])
    (for [k [:neon-tenant-id :neon-timeline-id]
          :let [v (get opts k)]
          :when (and (not (missing? v)) (not (re-matches hex32-re (str v))))]
      (str k " must be 32 lowercase hex characters"))
    (for [k [:neon-database :neon-role]
          :let [v (get opts k)]
          :when (and (not (missing? v)) (not (re-matches ident-re (str v))))]
      (str k " must be a lowercase identifier"))
    (when (= "cloud_admin" (str (:neon-role opts)))
      [":neon-role must not be cloud_admin"])
    (for [k [:neon-r2-endpoint :langfuse-backup-r2-endpoint :r2-endpoint]
          :when (and (not (missing? (get opts k)))
                     (not (re-matches url-re (str (get opts k)))))]
      (str k " must be an https URL"))

    ;; --- buckets ---------------------------------------------------------------
    ;; Live data and OpenTofu state must not share a bucket: one lifecycle
    ;; mistake would take out both. Backups must share a bucket with neither.
    (for [k [:neon-r2-bucket :langfuse-s3-bucket]
          :when (and (not (missing? (get opts k)))
                     (= (str (get opts k)) (str (:r2-bucket opts))))]
      (str k " must not be the OpenTofu state bucket"))
    (when (and (not (missing? (:langfuse-backup-r2-bucket opts)))
               (contains? (hash-set (str (:r2-bucket opts)) (str (:neon-r2-bucket opts))
                                    (str (:langfuse-s3-bucket opts)))
                          (str (:langfuse-backup-r2-bucket opts))))
      [":langfuse-backup-r2-bucket must not be the state or a live-data bucket"])

    ;; --- backups ----------------------------------------------------------------
    (for [k [:langfuse-backup-retention-days :langfuse-postgres-backup-max-age-hours
             :langfuse-clickhouse-backup-max-age-hours :langfuse-media-backup-max-age-hours]
          :when (and (not (missing? (get opts k)))
                     (not (when-let [n (as-int (get opts k))] (pos? n))))]
      (str k " must be a positive integer"))

    ;; --- network ----------------------------------------------------------------
    (when (and (not (missing? (:vultr-vpc-subnet opts)))
               (not (re-matches cidr-v4-re (str (:vultr-vpc-subnet opts)))))
      [":vultr-vpc-subnet must be an IPv4 CIDR, e.g. 10.50.0.0/24"])
    ;; Restricting the origin to Cloudflare's ranges and NOT proxying the
    ;; record are mutually exclusive, and the failure is silent until the
    ;; certificate is needed: Caddy answers the ACME HTTP-01 challenge on :80,
    ;; and with the record unproxied that challenge arrives from Let's
    ;; Encrypt's own addresses, which the firewall drops.
    (when (and (= "cloudflare" (str (:vultr-http-sources opts)))
               (not (true? (:cloudflare-proxied opts))))
      [":vultr-http-sources cloudflare requires :cloudflare-proxied true, or ACME HTTP-01 is firewalled off and no certificate is ever issued"])
    (when-not (or (missing? (:r2-credential-sharing opts))
                  (contains? #{"split" "shared-accepted"} (str (:r2-credential-sharing opts))))
      [":r2-credential-sharing must be split or shared-accepted"])
    (when-not (or (missing? (:vultr-os-id opts)) (integer? (:vultr-os-id opts)))
      [":vultr-os-id must be Vultr's numeric operating-system id"]))))

(defn backend-secrets [opts]
  (:secrets (get-in once-validate/providers
                    [:provider-backend (:provider-backend opts)])))

(def provider-secrets
  "What talking to the providers needs, on any real event."
  [:vultr-api-key :cloudflare-api-token])

(def storage-secrets
  "The two pairs that reach hosts on a create. `neon-r2-*` is what the
  getcolors/neon play reads for the storage tier; `langfuse-storage-r2-*` is
  what the app host uses for events and media. The deployment's `.envrc` maps
  one onto the other when they are the same token."
  [:neon-r2-access-key-id :neon-r2-secret-access-key
   :langfuse-storage-r2-access-key-id :langfuse-storage-r2-secret-access-key
   :langfuse-backup-r2-access-key-id :langfuse-backup-r2-secret-access-key])

(def application-secrets
  "Operator-held on purpose. A host-generated secret that no backup carries
  dies with the app host and takes every encrypted row with it; the init
  password is what logs an operator in after that host is rebuilt."
  [:langfuse-encryption-key :langfuse-salt :langfuse-init-user-password])

(defn- same-pair? [opts a b]
  (and (not (missing? (get opts a))) (= (str (get opts a)) (str (get opts b)))))

(defn secret-errors
  "Credentials a real event needs. A delete tears down infrastructure and never
  converges anything, so it asks for the provider credentials only."
  [opts event]
  (let [create? (= :create event)
        ks (concat provider-secrets
                   (when create? (concat storage-secrets application-secrets))
                   (backend-secrets opts))]
    (concat
     (for [k (distinct ks) :when (missing? (get opts k))]
       (str "required credential is not set: " (green-cli/par-name k)))
     ;; Blast radius, enforced rather than merely observed. The shared pair
     ;; stays reachable, but only as a deliberate, committed choice.
     (when (and create? (not (credential-sharing-accepted? opts)))
       (for [[label k] [["live Neon data" :neon-r2-access-key-id]
                        ["Langfuse events and media" :langfuse-storage-r2-access-key-id]
                        ["backups" :langfuse-backup-r2-access-key-id]]
             :when (same-pair? opts k :r2-access-key-id)]
         (str label " would use the same R2 credential as OpenTofu state. Supply "
              (green-cli/par-name k) " scoped to its own bucket, or set "
              ":r2-credential-sharing: shared-accepted in colors.yml to record "
              "that the blast radius is accepted")))
     (when (and create? (not (credential-sharing-accepted? opts))
                (same-pair? opts :langfuse-backup-r2-access-key-id :langfuse-storage-r2-access-key-id))
       [(str "backups would use the same R2 credential as live data. A backup a "
             "compromised host can erase is not a backup; supply "
             (green-cli/par-name :langfuse-backup-r2-access-key-id)
             " scoped to the backup bucket alone, or set "
             ":r2-credential-sharing: shared-accepted in colors.yml")])
     (when (and create? (not (missing? (:langfuse-encryption-key opts)))
                (not (re-matches hex64-re (str (:langfuse-encryption-key opts)))))
       [(str (green-cli/par-name :langfuse-encryption-key)
             " must be 64 lowercase hex characters (openssl rand -hex 32)")])
     (when (and create? (not (missing? (:langfuse-salt opts)))
                (< (count (str (:langfuse-salt opts))) 32))
       [(str (green-cli/par-name :langfuse-salt) " must be at least 32 characters")])
     (when (and create? (not (missing? (:langfuse-init-user-password opts)))
                (< (count (str (:langfuse-init-user-password opts))) 12))
       [(str (green-cli/par-name :langfuse-init-user-password) " must be at least 12 characters")]))))

(defn tofu-env [opts slot]
  (case slot
    :provider-compute {:vultr-api-key "VULTR_API_KEY"}
    :provider-dns     {:cloudflare-api-token "CLOUDFLARE_API_TOKEN"}
    :provider-backend (:tofu-env (get-in once-validate/providers
                                         [:provider-backend (:provider-backend opts)]) {})
    {}))
