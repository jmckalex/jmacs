;;; faces.lisp — the customisation surface for font faces.
;;;
;;; A *face* is a tagged attribute set: foreground colour, background
;;; colour, weight, slant, underline, strike-through. Syntax highlight
;;; tokens (tree-sitter capture names like `@keyword`) become CSS
;;; classes (`tok-keyword`) painted by face attributes.
;;;
;;; This file defines the registration primitive `defface` and the
;;; resolution machinery that combines, for a given face and the active
;;; theme:
;;;
;;;   1. the built-in default registered by `defface` for the theme;
;;;   2. the user's per-theme override (under `themes.<name>`); and
;;;   3. the user's global override (under `global`).
;;;
;;; More-specific wins (per-theme beats global beats default), but any
;;; attribute the user did not override falls through to the default.
;;;
;;; The companion file `themes.lisp` is rewritten as a sequence of
;;; `defface` forms — one per face — supplying the three theme defaults.
;;; The Lisp side hands the host a resolved face map; the host writes a
;;; `<style id="face-overrides">` element. No CSS variables for tokens.

;; face-name (a symbol) -> face descriptor map. A descriptor:
;;   {:name :doc :parent :default-light :default-dark :default-midnight}
;; Each :default-<theme> is itself a face map: a hash-map of attribute
;; symbols (e.g. :foreground) to values. `:parent` is either nil or a
;; symbol naming another registered face — used by the resolver to layer
;; the parent's resolved face under the child's own attributes.
(define *face-registry* {})

;; In-memory overrides. The structure mirrors faces.json:
;;   :global  -> { face-name -> face-attrs }
;;   :themes  -> { theme-name -> { face-name -> face-attrs } }
;;   :perMode -> { mode-name -> { face-name -> face-attrs } }
;; The per-mode bucket lets a face's colour differ by major mode; it is
;; resolved on top of the global/theme/default layers (see
;; `resolve-face-for-mode`) and painted via mode-scoped CSS in the host
;; (a `[data-major-mode="…"] .tok-<face>` rule).
(define *face-overrides* (hash-map :global {} :themes {} :perMode {}))

;; Regeneration of `<style id="face-overrides">` lives in the host:
;; the primitive `apply-face-styles!` reads `current-face-styles` and
;; writes the style element. Tests stub it as a no-op. There is no
;; intermediate hook — Lisp code calls the primitive directly via
;; `-on-face-change!`.

;; --- the face constructor ---------------------------------------------

(define (face . pairs)
  "Build a face descriptor (a hash-map) from keyword-value pairs:
   (face :foreground \"#aaa\" :weight :bold). Any attribute may be
   omitted; consumers must tolerate missing keys."
  (apply hash-map pairs))

;; --- registration -----------------------------------------------------

(define (-defface-impl name parent options)
  "Underlying registration routine. NAME (a symbol), PARENT (nil or a
   symbol naming another face), and OPTIONS (a list of keyword pairs:
   :doc string, :default-light face, :default-dark face,
   :default-bright face, :default-midnight face). On a hot reload the
   existing overrides survive — only the registry entry is rewritten."
  (let ((opts (apply hash-map options)))
    (set! *face-registry*
          (assoc *face-registry* name
                 (hash-map
                  :name name
                  :doc (get opts :doc "")
                  :parent parent
                  :default-light    (get opts :default-light {})
                  :default-dark     (get opts :default-dark {})
                  :default-bright   (get opts :default-bright {})
                  :default-midnight (get opts :default-midnight {}))))))

;; defface — register a face with optional `from PARENT` inheritance.
;;
;;   (defface 'name :doc "…" :default-light (face …) …)
;;   (defface 'name from 'parent :doc "…" :default-light (face …) …)
;;
;; The `from` keyword is a single literal symbol between the face name
;; and the first keyword option. Single parent only — multi-inheritance
;; would force semantic choices we'd rather avoid. The child's per-theme
;; attributes layer on top of the parent's resolved face; see
;; `resolve-face` below for the full layering rule (parent chain bottom-
;; up, then user overrides at each level).
(defmacro defface (name . rest)
  (let* ((has-from (and (pair? rest)
                        (symbol? (car rest))
                        (eq? (car rest) 'from)))
         (parent-form (if has-from (car (cdr rest)) nil))
         (options (if has-from (cdr (cdr rest)) rest)))
    (list '-defface-impl
          name
          (if has-from parent-form nil)
          (cons 'list options))))

;; --- user-defined faces ------------------------------------------------
;; Faces created from the customisation flow (C-h F, `create-face!`) are
;; recorded here so they can be persisted and re-registered on the next
;; launch (a `defface` is code, not data, so we persist the *arguments*
;; and replay them via `-defface-impl`). Each entry:
;;   name -> { :doc :parent :light :dark :bright :midnight }
;; where each theme value is a face attribute map.
(define *user-faces* {})

(define (-record-user-face! name parent doc light dark bright midnight)
  "Record a user face's defining attributes for persistence."
  (set! *user-faces*
        (assoc *user-faces* name
               (hash-map :doc doc :parent parent
                         :light light :dark dark
                         :bright bright :midnight midnight))))

(define (user-faces)
  "The registry of user-created faces (for persistence). Plain data."
  *user-faces*)

(define (user-face? name)
  "True when NAME was created by the user (not a built-in defface)."
  (contains? *user-faces* name))

(define (create-face! name color . options)
  "Create (or recolour) a user face NAME (a symbol or string) with
   foreground COLOR (a hex string). Optional keyword args:
     :parent  a registered face NAME to inherit from (symbol/string/nil)
     :doc     a documentation string
   The same colour seeds every theme default (light/dark/bright/midnight);
   the user can recolour per theme/mode afterwards via customize. The
   face is registered live, applied immediately, and persisted so it
   survives a restart. Side-effecting; note the `!`."
  (let* ((opts (apply hash-map options))
         (sym-name (if (symbol? name) name (string->symbol (str name))))
         (parent-opt (get opts :parent nil))
         (parent (cond ((nil? parent-opt) nil)
                       ((symbol? parent-opt) parent-opt)
                       (else (string->symbol (str parent-opt)))))
         (doc (get opts :doc (str "User face " (symbol->string sym-name))))
         (attrs (face :foreground color)))
    (-defface-impl sym-name parent
                   (list :doc doc
                         :default-light attrs
                         :default-dark attrs
                         :default-bright attrs
                         :default-midnight attrs))
    (-record-user-face! sym-name parent doc attrs attrs attrs attrs)
    (-on-face-change!)
    sym-name))

(define (set-user-faces! faces)
  "Replace the user-face registry with FACES and re-register each one
   into the live face registry. Called by the host at load. Does NOT
   persist (the host calls it while loading)."
  (set! *user-faces* (if (nil? faces) {} faces))
  (-replay-user-faces! (keys *user-faces*)))

(define (-replay-user-faces! names)
  "Re-run `-defface-impl` for each recorded user face so it is present
   in `*face-registry*` after a fresh stdlib load."
  (unless (nil? names)
    (let* ((name (car names))
           (entry (get *user-faces* name {})))
      (-defface-impl name (get entry :parent nil)
                     (list :doc (get entry :doc "")
                           :default-light (get entry :light {})
                           :default-dark (get entry :dark {})
                           :default-bright (get entry :bright {})
                           :default-midnight (get entry :midnight {}))))
    (-replay-user-faces! (cdr names))))

(define (face-registered? name)
  "True when NAME names a registered face."
  (contains? *face-registry* name))

(define (face-entry name)
  "The registry entry for face NAME, or nil."
  (get *face-registry* name nil))

(define (registered-faces)
  "The names of every registered face."
  (keys *face-registry*))

;; --- resolution -------------------------------------------------------

(define (-face-own-default name theme)
  "The face's OWN per-theme default attributes (no inheritance),
   straight from the registry. Empty map for an unknown face."
  (let ((entry (face-entry name)))
    (cond
      ((nil? entry) {})
      ((eq? theme 'light)    (get entry :default-light    {}))
      ((eq? theme 'dark)     (get entry :default-dark     {}))
      ((eq? theme 'bright)   (get entry :default-bright   {}))
      ((eq? theme 'midnight) (get entry :default-midnight {}))
      (else                  (get entry :default-dark     {})))))

(define (face-parent name)
  "The parent face NAME inherits from, or nil. Unknown faces return nil."
  (let ((entry (face-entry name)))
    (if (nil? entry) nil (get entry :parent nil))))

(define (face-default name theme)
  "The built-in default for face NAME under THEME (a symbol). Equivalent
   to the face's own theme-block; does NOT walk the parent chain. Kept
   for backward compatibility with introspection tooling; the full
   inheritance-aware resolution lives in `resolve-face`."
  (-face-own-default name theme))

(define (-format-cycle names)
  "Render a list of face symbols as `a -> b -> c -> a` for cycle errors."
  (cond
    ((nil? names) "")
    ((nil? (cdr names)) (symbol->string (car names)))
    (else (string-append (symbol->string (car names))
                         " -> "
                         (-format-cycle (cdr names))))))

(define (face-global-override name)
  "The user's global override for face NAME, or an empty map."
  (get (get *face-overrides* :global {}) name {}))

(define (face-theme-override name theme)
  "The user's per-theme override for face NAME under THEME, or {}."
  (get (get (get *face-overrides* :themes {}) theme {}) name {}))

(define (-merge-faces-step ks over acc)
  "Tail-recursive helper for merge-faces."
  (if (nil? ks)
      acc
      (-merge-faces-step (cdr ks) over
                         (assoc acc (car ks) (get over (car ks) nil)))))

(define (merge-faces base over)
  "Layer face OVER atop BASE, attribute by attribute. Keys present in
   OVER win; keys present only in BASE are preserved."
  (-merge-faces-step (keys over) over base))

(define (-resolve-one name theme)
  "The fully-resolved attribute map contributed by a single face NAME
   under THEME — its own theme-default layered with its user global and
   per-theme overrides. No inheritance is walked here; the chain walker
   composes these per-face contributions bottom-up."
  (merge-faces
   (merge-faces (-face-own-default name theme) (face-global-override name))
   (face-theme-override name theme)))

(define (-resolve-with-chain name theme visited)
  "Walk the parent chain from NAME up to the topmost ancestor, then
   layer each face's `(default + user-overrides)` contribution back
   down. VISITED tracks names already on the chain — a repeat raises a
   `face inheritance cycle` error naming the path."
  (cond
    ((nil? name) {})
    ((nil? (face-entry name)) {})
    ((member name visited)
     (error (str "face inheritance cycle: "
                 (-format-cycle (reverse (cons name visited))))))
    (else
     (let ((parent (face-parent name))
           (own (-resolve-one name theme)))
       (if (nil? parent)
           own
           (merge-faces
            (-resolve-with-chain parent theme (cons name visited))
            own))))))

(define (resolve-face name theme)
  "The fully-resolved face for NAME under THEME, with inheritance.
   The parent chain (topmost ancestor first) contributes its
   `(default + user-overrides)` first; each child layers its own
   `(default + user-overrides)` on top. The result is a flat hash-map
   of attribute keywords to values."
  (-resolve-with-chain name theme '()))

(define (face-attribute name attr . options)
  "Return one attribute of face NAME. With no :theme, uses the active
   theme (*theme*). With (:theme 'dark), uses that theme explicitly."
  (let ((opts (apply hash-map options)))
    (let ((theme (get opts :theme *theme*)))
      (get (resolve-face name theme) attr nil))))

;; --- per-mode resolution ----------------------------------------------
;; A per-mode override layers on TOP of the fully-resolved face for the
;; active theme. MODE is the major-mode display name (a string, e.g.
;; "LaTeX"). These contribute the mode-scoped `.tok-<face>` CSS rules.

(define (-mode-overrides)
  "The per-mode-overrides sub-map: mode-name -> { face -> attrs }."
  (get *face-overrides* :perMode {}))

(define (face-mode-override name mode)
  "The user's per-mode override for face NAME under MODE, or {}."
  (get (get (-mode-overrides) mode {}) name {}))

(define (resolve-face-for-mode name theme mode)
  "The resolved face for NAME under THEME, with MODE's per-mode override
   layered on top of the normal (default + global + per-theme + parent)
   resolution."
  (merge-faces (resolve-face name theme) (face-mode-override name mode)))

(define (modes-with-overrides)
  "The names of every major mode that has at least one per-mode face
   override."
  (keys (-mode-overrides)))

(define (faces-overridden-in-mode mode)
  "The names of the faces overridden in MODE."
  (keys (get (-mode-overrides) mode {})))

;; --- the data the host paints with ------------------------------------

(define (-resolved-faces-step names theme acc)
  "Tail-recursive helper for resolved-faces."
  (if (nil? names)
      acc
      (-resolved-faces-step
       (cdr names) theme
       (assoc acc (car names) (resolve-face (car names) theme)))))

(define (resolved-faces theme)
  "A hash-map of face-name -> resolved face for every registered face
   under THEME. This is what the host renderer turns into CSS."
  (-resolved-faces-step (registered-faces) theme {}))

(define (current-resolved-faces)
  "The resolved faces for the active theme — what the renderer applies."
  (resolved-faces *theme*))

(define (face-attribute-list face)
  "A flat alist ((:foreground . \"#aaa\") (:weight . :bold) …) for a
   resolved face. Convenient for hosts that walk a list more easily
   than a hash-map."
  (map (lambda (k) (cons k (get face k nil))) (keys face)))

(define (faces->alist faces)
  "Turn a face-name -> face map into an alist
   ((face-name . face-attribute-list) …) — pure list/cons data the
   host can walk without map primitives."
  (map (lambda (name)
         (cons name (face-attribute-list (get faces name {}))))
       (keys faces)))

(define (current-face-styles)
  "The data the renderer paints into `<style id=\"face-overrides\">`.
   An alist of (face-name . ((:attr . value) …))."
  (faces->alist (current-resolved-faces)))

;; --- per-mode resolved styles for the host ----------------------------
;; For each mode with overrides, the host paints a mode-scoped rule
;; (`[data-major-mode="MODE"] .tok-<face> { … }`). We resolve ONLY the
;; faces that mode actually overrides — the rest fall through to the
;; global `.tok-<face>` rule — and emit the full resolved attrs so the
;; scoped rule fully specifies the face's appearance in that mode.

(define (-mode-face-styles-for mode)
  "An alist (face-name . ((:attr . value) …)) for the faces overridden
   in MODE, fully resolved under the active theme + MODE."
  (map (lambda (name)
         (cons name
               (face-attribute-list
                 (resolve-face-for-mode name *theme* mode))))
       (faces-overridden-in-mode mode)))

(define (current-mode-face-styles)
  "An alist (mode-name . ((face-name . ((:attr . value) …)) …)) — one
   entry per major mode that has per-mode face overrides. The host turns
   each into mode-scoped `.tok-*` CSS. Empty when nothing is overridden
   per mode (the common case), so the host writes only the global rules."
  (map (lambda (mode) (cons mode (-mode-face-styles-for mode)))
       (modes-with-overrides)))

;; --- a hook the persistence layer installs (Phase 3) ------------------
;; Any change to *face-overrides* runs this — the host sets it to the
;; routine that writes faces.json. Default: do nothing.
(define *face-overrides-saver* nil)

(define (set-face-overrides-saver! fn)
  "Install a zero-argument procedure called after every change to the
   in-memory face overrides. The procedure receives no arguments and
   reads the live `*face-overrides*` value itself."
  (set! *face-overrides-saver* fn))

(define (-on-face-change!)
  "Internal: rerun CSS generation and persist after a change."
  (apply-face-styles!)
  (when (procedure? *face-overrides-saver*)
    (*face-overrides-saver*)))

;; --- mutators ---------------------------------------------------------
;; Three layers: a `:theme` kwarg targets a per-theme override; no
;; `:theme` targets the global override. The data layout mirrors
;; faces.json: top-level keys :global and :themes.

(define (-global-overrides)
  "The global-overrides sub-map."
  (get *face-overrides* :global {}))

(define (-theme-overrides theme)
  "The per-theme overrides sub-map for THEME."
  (get (get *face-overrides* :themes {}) theme {}))

(define (-set-global-face! name face)
  "Replace the global override for face NAME with FACE (a hash-map of
   attributes). An empty face removes the entry entirely."
  (let ((globals (-global-overrides)))
    (let ((updated (if (= (length face) 0)
                       (dissoc globals name)
                       (assoc globals name face))))
      (set! *face-overrides*
            (assoc *face-overrides* :global updated)))))

(define (-set-theme-face! theme name face)
  "Replace the per-theme override for NAME under THEME with FACE."
  (let ((themes (get *face-overrides* :themes {})))
    (let ((theme-map (get themes theme {})))
      (let ((updated-theme
             (if (= (length face) 0)
                 (dissoc theme-map name)
                 (assoc theme-map name face))))
        (let ((themes2
               (if (= (length updated-theme) 0)
                   (dissoc themes theme)
                   (assoc themes theme updated-theme))))
          (set! *face-overrides*
                (assoc *face-overrides* :themes themes2)))))))

(define (-set-mode-face! mode name face)
  "Replace the per-mode override for NAME under MODE with FACE. An empty
   FACE removes the entry; an emptied mode drops out of the bucket."
  (let ((modes (get *face-overrides* :perMode {})))
    (let ((mode-map (get modes mode {})))
      (let ((updated-mode
             (if (= (length face) 0)
                 (dissoc mode-map name)
                 (assoc mode-map name face))))
        (let ((modes2
               (if (= (length updated-mode) 0)
                   (dissoc modes mode)
                   (assoc modes mode updated-mode))))
          (set! *face-overrides*
                (assoc *face-overrides* :perMode modes2)))))))

(define (set-face-attribute name attr value . options)
  "Set ATTR of face NAME to VALUE.

   Without :theme/:mode — modifies the global override. With (:theme
   'dark) — modifies the per-theme override. With (:mode \"LaTeX\") —
   modifies the per-mode override (the face's colour in that major mode
   only). Triggers CSS regeneration and (when installed) persistence."
  (let ((opts (apply hash-map options)))
    (let ((theme (get opts :theme nil))
          (mode (get opts :mode nil)))
      (cond
        ((not (nil? mode))
         (let ((current (face-mode-override name mode)))
           (-set-mode-face! mode name (assoc current attr value))))
        ((not (nil? theme))
         (let ((current (face-theme-override name theme)))
           (-set-theme-face! theme name (assoc current attr value))))
        (else
         (let ((current (face-global-override name)))
           (-set-global-face! name (assoc current attr value)))))
      (-on-face-change!))))

(define (set-face-in-mode! name mode attrs)
  "Replace the per-mode override of face NAME in MODE (a major-mode
   display name) with the attribute map ATTRS at once. Live + persists."
  (-set-mode-face! mode name attrs)
  (-on-face-change!))

(define (reset-face-in-mode! name mode)
  "Drop the per-mode override of face NAME in MODE. Live + persists."
  (-set-mode-face! mode name {})
  (-on-face-change!))

(define (set-face! name attrs . options)
  "Replace every overridden attribute of face NAME with the attribute
   map ATTRS at once (still layered over the default — attributes not
   in ATTRS fall back to the default). Same :theme kwarg as
   set-face-attribute."
  (let ((opts (apply hash-map options)))
    (let ((theme (get opts :theme nil)))
      (if (nil? theme)
          (-set-global-face! name attrs)
          (-set-theme-face! theme name attrs))
      (-on-face-change!))))

(define (reset-face name . options)
  "Drop overrides for face NAME. Without :theme, drops the global
   override only. With (:theme 'dark), drops the per-theme override
   for that theme only."
  (let ((opts (apply hash-map options)))
    (let ((theme (get opts :theme nil)))
      (if (nil? theme)
          (-set-global-face! name {})
          (-set-theme-face! theme name {}))
      (-on-face-change!))))

(define (reset-all-faces)
  "Wipe every override — global, per-theme and per-mode. The renderer
   reverts to built-in defaults for the active theme."
  (set! *face-overrides* (hash-map :global {} :themes {} :perMode {}))
  (-on-face-change!))

;; --- the persistence shape --------------------------------------------
;; Read by `set-face-overrides!` to install a faces.json blob the host
;; loaded at startup. The blob is plain Lisp data — two top-level keys:
;;   :global { name -> face }
;;   :themes { theme -> { name -> face } }
;; Faces themselves are hash-maps of attribute keyword -> value.

(define (set-face-overrides! overrides)
  "Replace the live overrides with OVERRIDES (a hash-map shaped as
   above). Triggers CSS regeneration but DOES NOT call the saver —
   the host calls this during load, when persisting back would loop."
  (set! *face-overrides*
        (hash-map
         :global (get overrides :global {})
         :themes (get overrides :themes {})
         :perMode (get overrides :perMode {})))
  (apply-face-styles!))

(define (current-face-overrides)
  "Return the live overrides map. The persistence layer reads this
   to know what to write."
  *face-overrides*)

(define (current-faces-file)
  "The complete persistable face state — the colour overrides, the
   user-created faces, and the highlight rules — in one hash-map the
   host serialises to faces.json:
     {:overrides *face-overrides*
      :userFaces *user-faces*
      :highlightRules *highlight-rules*}
   `*highlight-rules*` is defined in highlight-rules.lisp, which loads
   after this file; the symbol resolves at call time."
  (hash-map :overrides *face-overrides*
            :userFaces *user-faces*
            :highlightRules *highlight-rules*))

;; --- the customisation buffer model -----------------------------------
;; The customize view reads `face-row` for each registered face and
;; renders the appropriate widgets. Each row is a list of plain data
;; — strings, values, booleans — so the view does not need to know
;; about hash-maps or keywords.

(define (-face-state name)
  "The state symbol for face NAME: 'set when any override touches it
   under any theme, 'standard when no override does."
  (let ((globals (-global-overrides))
        (themes (get *face-overrides* :themes {})))
    (let ((overridden-globally? (contains? globals name)))
      (if overridden-globally?
          'set
          (-face-state-themes (keys themes) themes name)))))

(define (-face-state-themes theme-names themes name)
  "Walk THEME-NAMES looking for a per-theme override of face NAME.
   Returns 'set when one is found, 'standard otherwise."
  (cond
    ((nil? theme-names) 'standard)
    ((contains? (get themes (car theme-names) {}) name) 'set)
    (else (-face-state-themes (cdr theme-names) themes name))))

(define (face-row name)
  "A face's data for the customize view: a list
   (name doc foreground background weight slant underline strike
    size family state) with each value as a string / number / boolean /
   nil, ready for widgets. `size` is a number (or \"\" when unset) and
   `family` a CSS font-family string (or \"\"); these are meaningful on
   the base `default` face and are an optional override elsewhere."
  (let ((entry (face-entry name)))
    (list (symbol->string name)
          (get entry :doc "")
          (or (face-attribute name :foreground) "")
          (or (face-attribute name :background) "")
          (-symbol-or-default (face-attribute name :weight) "normal")
          (-symbol-or-default (face-attribute name :slant) "normal")
          (-truthy? (face-attribute name :underline))
          (-truthy? (face-attribute name :strike-through))
          (-attr-or-empty name :size)
          (-attr-or-empty name :family)
          (symbol->string (-face-state name)))))

(define (-symbol-or-default value default)
  "Render a symbol/keyword value as a string, or DEFAULT when nil."
  (cond
    ((nil? value) default)
    ((symbol? value) (symbol->string value))
    ((keyword? value) (symbol->string value))
    (else (str value))))

(define (-truthy? value)
  "True when VALUE is something other than nil / #f. Bare #f and
   nil both count as false; any other value (a string, a keyword,
   #t) counts as true."
  (cond
    ((nil? value) false)
    ((eq? value false) false)
    (else true)))

(define (-attr-or-empty name attr)
  "Face attribute ATTR of NAME, or the empty string when unset. Unlike
   `(or … \"\")`, this normalises a *nil* result to \"\" (nil is truthy
   here, so `or` would pass it through) — the widgets want a clean empty
   value to mean \"inherit\"."
  (let ((v (face-attribute name attr)))
    (if (nil? v) "" v)))

(define (face-rows)
  "The data the customize view's Faces group renders: one face-row
   per registered face, ordered as registered (insertion order)."
  (map face-row (registered-faces)))

;; --- the commands -----------------------------------------------------
;; `customize-face` opens the customize buffer scrolled to face NAME;
;; the describe-face command (parallel agent) will dispatch to this.

(define (customize-face name)
  "Open the customisation buffer for the single face NAME (a symbol)."
  (open-customize-face! (symbol->string name)))

(defcommand customize-faces ()
  "Open the customisation buffer scoped to the Faces group."
  (open-customize-faces!))

;; --- string-keyed mutators for the host -------------------------------
;; The renderer (a JS module) speaks strings, not symbols / keywords.
;; These wrappers accept strings and intern them on the Lisp side.

(define (set-face-attribute-by-strings face-str attr-str value . options)
  "Wrapper around `set-face-attribute` that takes face name and
   attribute as strings — what the customize view's widgets feed back.
   Boolean values come through as JS booleans; symbolic values
   (weight \"bold\", slant \"italic\") arrive as strings."
  (let ((face-name (string->symbol face-str))
        (attr (string->keyword attr-str)))
    (let ((coerced (-coerce-attr-value attr-str value)))
      (apply set-face-attribute face-name attr coerced options))))

(define (-coerce-attr-value attr value)
  "Translate a value that arrived from the renderer's widget into
   the canonical Lisp form: weight/slant become keywords; size becomes a
   number; underline / strike-through stay boolean; colours and the font
   family stay strings."
  (cond
    ((or (string=? attr "weight") (string=? attr "slant"))
     (if (string? value) (string->keyword value) value))
    ((string=? attr "size")
     (if (and (string? value) (not (string=? value "")))
         (string->number value)
         value))
    (else value)))

(define (reset-face-by-string face-str)
  "Drop the global override of face FACE-STR."
  (reset-face (string->symbol face-str)))

;; --- the customize view model for faces -------------------------------
;; The customize view asks for a group model when it shows a group's
;; settings; for faces, we return a similar shape with a :faces array
;; instead of :settings. The host's JS bridge knows to render face rows.

(define (faces-group-model)
  "The model for the 'Faces' customize group: title, doc, parent,
   no subgroups, and the rows for every registered face."
  (list "faces"
        "Per-token syntax-highlighting faces. Each face has a
         foreground colour, optional background, weight, slant,
         underline and strike-through. Changes are live and persist
         across restarts."
        "godot"
        '()
        (face-rows)))

(define (face-single-model name-str)
  "The model for a single-face customize buffer: like the faces-group
   model but with just one face row, no parent link beyond the group."
  (list "face"
        (get (face-entry (string->symbol name-str)) :doc "")
        "faces"
        '()
        (list (face-row (string->symbol name-str)))))

;; Register a 'faces' customize group so it shows up in the top-level
;; customize buffer as a link the user can click into.
(defgroup 'faces 'godot
  "Per-token font faces — colours, weight, slant, decoration.")
