(ns io.github.getcolors.langfuse.ssh-config
  "The deployment's `~/.ssh/config` block, per the workspace SSH Config Standard.

  The block itself is written by the `ansible-local` stage, because that is the
  one place the addresses are known and because `blockinfile` already handles
  the idempotent replace. What lives here is everything that must happen before
  the stage renders: the aliases, the identity file, and the refusal to adopt a
  stanza this package did not write.

  Unlike the keypair, this play is the package's own copy rather than ONCE's
  (standard §7). The file is shared with every other host the operator reaches,
  so an unrelated change upstream must not be able to rewrite it at pin-bump
  time. The alias list, though, is the Compute Cluster Standard's (§6) and
  comes from ONCE."
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [io.github.getcolors.langfuse.topology :as topology]
            [io.github.getcolors.once.compute-cluster :as once-cluster]))

(defn host-alias
  "The profile, unchanged. Standard §2: the profile already keys remote state,
  which is what makes it unique enough to name a host by. It reaches the app
  host, the machine an operator most often means."
  [opts]
  (or (:profile opts) "langfuse"))

(defn identity-file
  "`~/.ssh/<profile>`, written with a literal tilde rather than an expanded
  home directory. OpenSSH expands it, and leaving it unexpanded is what keeps
  the rendered block identical on every workstation."
  [opts]
  (str "~/.ssh/" (host-alias opts)))

(defn aliases
  "Every alias this deployment owns: the bare profile, and one per machine —
  `<profile>-<role>` for the singletons, `<profile>-clickhouse-<i>` for the
  replicas. ONCE derives the list from the spec (Compute Cluster Standard
  §6). Six machines are operable only if each can be reached by name; the
  bare profile keeps `ssh <profile>` meaning what it means in every other
  deployment."
  [opts]
  (once-cluster/aliases topology/spec opts))

(defn machine-alias
  "The alias for one machine: its entry in ONCE's list, paired with the host
  by id. Derived from the profile, not from the machine's label, so an
  operator who set `vultr-name` still reaches every machine as
  `<profile>-<role>[-<i>]`."
  [opts host]
  (get (zipmap (once-cluster/node-ids topology/spec opts) (rest (aliases opts)))
       {:role (:role host) :index (or (:index host) 0)}))

(defn config-path []
  (io/file (System/getProperty "user.home") ".ssh" "config"))

(defn begin-marker [alias] (str "# BEGIN " alias " ANSIBLE MANAGED BLOCK"))
(defn end-marker [alias] (str "# END " alias " ANSIBLE MANAGED BLOCK"))

(defn owned-markers [alias]
  {:begin #{(begin-marker alias)}
   :end #{(end-marker alias)}})

(defn host-patterns
  "The patterns a `Host` line declares, or nil when the line is not one."
  [line]
  (when-let [[_ rest] (re-matches #"(?i)\s*Host\s+(.*?)\s*" line)]
    (remove str/blank? (str/split rest #"\s+"))))

(defn foreign-stanza-line
  "The 1-based line number of a `Host <alias>` stanza that this package did not
  write, or nil. Lines between our own markers are ours and are skipped.

  `alias` is the stanza being searched for; `marker-alias` names the managed
  block, and the two are not the same thing: this deployment writes ONE block,
  marked with the profile, containing a stanza for the profile and for every
  machine."
  ([lines alias] (foreign-stanza-line lines alias alias))
  ([lines alias marker-alias]
   (let [{:keys [begin end]} (owned-markers marker-alias)]
     (loop [[line & more] lines n 1 inside? false]
       (cond
         (nil? line) nil
         (contains? begin (str/trim line)) (recur more (inc n) true)
         (contains? end (str/trim line)) (recur more (inc n) false)
         (and (not inside?) (some #{alias} (host-patterns line))) n
         :else (recur more (inc n) inside?))))))

(defn leading-option-line
  "The 1-based line number of an option standing above the first `Host` or
  `Match` line, or nil. Such an option is global; the block is written with
  `insertbefore: BOF`, so it would capture that option into this deployment's
  stanza, silently narrowing a global setting to one host."
  [lines]
  (loop [[line & more] lines n 1]
    (let [trimmed (str/trim (str line))]
      (cond
        (nil? line) nil
        (or (str/blank? trimmed) (str/starts-with? trimmed "#")) (recur more (inc n))
        (re-matches #"(?i)\s*(Host|Match)\s+.*" line) nil
        :else n))))

(defn adopt-error
  "The standard's never-adopt rule (§5), checked for every alias this
  deployment claims."
  [opts]
  (let [f (config-path)]
    (when (.isFile f)
      (let [lines (str/split-lines (slurp f))
            marker (host-alias opts)]
        (when-let [[alias n] (some (fn [a]
                                     (when-let [n (foreign-stanza-line lines a marker)]
                                       [a n]))
                                   (aliases opts))]
          (str "refusing to manage " (.getPath f) ": it already declares "
               "`Host " alias "` at line " n
               " outside this package's managed block. Remove or rename that "
               "stanza if it is stale, or change `profile` if it belongs to "
               "something else; this package will not overwrite it."))))))

(defn placement-error [_opts]
  (let [f (config-path)]
    (when (.isFile f)
      (when-let [n (leading-option-line (str/split-lines (slurp f)))]
        (str "refusing to manage " (.getPath f) ": line " n
             " sets an option above the first `Host` line, so it applies to "
             "every host. This package inserts its block at the top of the "
             "file, which would capture that option into one stanza. Move "
             "those global options below the managed block, or into an "
             "explicit `Host *` stanza at the end of the file, and retry.")))))

(defn preflight!
  "Run the local checks. Real create only: build and dry-run must not read
  `~/.ssh/config` at all (§6)."
  [opts]
  (if-let [err (or (adopt-error opts) (placement-error opts))]
    (assoc opts :green/exit 1 :green/err err)
    opts))
