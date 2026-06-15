;;; element-view-atari.lisp — the Atari 2600 emulator as an element-view.
;;;
;;; The first client of `define-element-view` (see element-views.lisp):
;;; the entire integration of a third-party WASM emulator is these few
;;; lines of Lisp — no host code. `<stella-emulator>` is the Stella Atari
;;; 2600 core (GPLv2), vendored in apps/desktop/vendor/stella/; see
;;; ATTRIBUTION.md / licenses/Stella-GPLv2.txt.
;;;
;;; The bundled freeware demo ROM (Oystron © 1997 Piero Cavina) auto-loads
;;; so `M-x atari` shows a playable game immediately; the toolbar's Load
;;; button (and drag-and-drop onto the screen) opens any other
;;; .a26/.bin/.rom/.zip. Click the screen to focus it, then press Reset
;;; (the toolbar button or Enter) to start a freshly-loaded cartridge.
;;;
;;; Drop the `(src …)` attribute below to start with an empty emulator.
;;; To exclude Atari entirely, remove this file from STDLIB_FILES and the
;;; apps/desktop/vendor/stella/ directory — the mechanism stays.

(define-element-view atari
  :title    "Atari 2600"
  :module   "apps/desktop/vendor/stella/stella-element.js"
  :tag      "stella-emulator"
  :attrs    '((controls)
              (src "app://editor/apps/desktop/vendor/stella/oystron.bin"))
  :keyboard 'grab)
