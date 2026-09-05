(ns pin (:require [clojure.java.shell :as sh] [clojure.string :as str]))
;; One SHA, three payloads. Every payload is born unpinned -- no invented SHAs --
;; and `bb pin` stamps or re-stamps it after a clean, pushed HEAD. Each site
;; recognises exactly two forms, its unpinned birth shape and its pinned shape,
;; and the run fails loudly when a payload matches neither.
;;
;; Only this repository's own SHA is written here. The pins this package depends
;; on -- green, once, neon, red, blue -- are edited by hand in deps.edn,
;; red/package.json, blue/pyproject.toml and the red payload's PINS, and
;; scripts/launcher.sh checks that the neon pin agrees across all four.
(defn git [& args] (let [{:keys [exit out]} (apply sh/sh "git" args)] (when (zero? exit) (str/trim out))))

(defn stamp-green [s sha]
  (when (re-find #"\(def \^:private langfuse-sha (?:nil|\"[0-9a-f]{40}\")\)" s)
    (str/replace-first s #"\(def \^:private langfuse-sha (?:nil|\"[0-9a-f]{40}\")\)"
                       (str "(def ^:private langfuse-sha \"" sha "\")"))))

(defn stamp-red [s sha]
  (let [pinned (str "\"package-langfuse-red\": \"github:getcolors/langfuse#" sha "\",")]
    (cond (str/includes? s "\"package-langfuse-red\": null,")
          (str/replace-first s "\"package-langfuse-red\": null," pinned)
          (re-find #"\"package-langfuse-red\": \"github:getcolors/langfuse#[0-9a-f]{40}\"," s)
          (str/replace-first s #"\"package-langfuse-red\": \"github:getcolors/langfuse#[0-9a-f]{40}\"," pinned))))

;; The blue payload's PEP 723 block must name every source itself. uv applies a
;; project's own `[tool.uv.sources]`, and a script's, but nothing here may
;; depend on it reading them out of a dependency -- so the storage tier and
;; ONCE are declared beside this package rather than left to resolution.
(def blue-unpinned-meta "# dependencies = []\n# ///")
(defn blue-pinned-meta [sha]
  (str "# dependencies = [\"package-langfuse-blue\", \"blue\"]\n"
       "#\n"
       "# [tool.uv.sources]\n"
       "# package-langfuse-blue = { git = \"https://github.com/getcolors/langfuse.git\", rev = \"" sha "\", subdirectory = \"blue\" }\n"
       "# package-neon-blue = { git = \"https://github.com/getcolors/neon.git\", rev = \"87c009549a928fdf1f9dc135f9740c3baa5782d7\", subdirectory = \"blue\" }\n"
       "# package-once-blue = { git = \"https://github.com/getcolors/once.git\", rev = \"b1628b7f8546c10fa9b768565bfd839512cb49ca\", subdirectory = \"blue\" }\n"
       "# blue = { git = \"https://github.com/getcolors/blue.git\", rev = \"290f313ead5ca162875c33a049c880da017eae09\" }\n"
       "#\n"
       ;; package-once-blue and package-neon-blue carry their own, older blue
       ;; pins, and package-neon-blue carries its own, older ONCE pin; the
       ;; overrides make this package's blue and ONCE pins win, as they do in
       ;; blue/pyproject.toml. Without the ONCE override uv refuses the two
       ;; ONCE URLs as a conflict, from a copied payload only (launcher.sh).
       "# [tool.uv]\n"
       "# override-dependencies = [\"blue @ git+https://github.com/getcolors/blue.git@290f313ead5ca162875c33a049c880da017eae09\", \"package-once-blue @ git+https://github.com/getcolors/once.git@b1628b7f8546c10fa9b768565bfd839512cb49ca#subdirectory=blue\"]\n"
       "# ///"))
(defn stamp-blue [s sha]
  ;; First stamp is structural: the metadata block gains its git sources and the
  ;; UNPINNED paragraph collapses to a pinned-state note. Re-pinning is a SHA swap.
  (cond (str/includes? s blue-unpinned-meta)
        (-> s
            (str/replace-first blue-unpinned-meta (blue-pinned-meta sha))
            (str/replace-first #"(?s)# UNPINNED:.*?LANGFUSE_LIB_ROOT=/path/to/langfuse\n"
                               "# Stamped by `bb pin`. LANGFUSE_LIB_ROOT=/path/to/langfuse still overrides the\n# pin with a working tree.\n"))
        (re-find #"langfuse\.git\", rev = \"[0-9a-f]{40}\"" s)
        (str/replace-first s #"langfuse\.git\", rev = \"[0-9a-f]{40}\""
                           (str "langfuse.git\", rev = \"" sha "\""))))

(def sites
  [{:path "../skills/package-langfuse-green/green" :stamp stamp-green}
   {:path "../skills/package-langfuse-red/red" :stamp stamp-red}
   {:path "../skills/package-langfuse-blue/blue" :stamp stamp-blue}])

(let [dirty (git "status" "--porcelain") sha (git "rev-parse" "HEAD") remotes (git "branch" "-r" "--contains" sha)]
  (cond (seq dirty)
        (do (binding [*out* *err*] (println "langfuse working tree is dirty; commit before pinning")) (System/exit 2))
        (not (str/includes? (str remotes) "origin/"))
        (do (binding [*out* *err*] (println "langfuse HEAD is not pushed")) (System/exit 2))
        :else
        (let [errors (atom [])]
          (doseq [{:keys [path stamp]} sites]
            (let [s (slurp path) n (stamp s sha)]
              (if n (spit path n) (swap! errors conj (str "could not locate a pin form in " path)))))
          (if (seq @errors)
            (do (binding [*out* *err*] (println (str/join "\n" @errors))) (System/exit 2))
            (println "pinned 3 launchers to" (subs sha 0 7))))))
