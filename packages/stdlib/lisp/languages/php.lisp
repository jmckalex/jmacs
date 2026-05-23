;;; php.lisp — the PHP major modes.
;;;
;;; Two modes, one tree-sitter grammar each. `php-mode' handles the
;;; common mixed-source case (HTML with `<?php … ?>' regions); the
;;; renderer's PHP grammar marks the HTML chunks for injection and the
;;; HTML highlighter renders them — and recursively the JS/CSS
;;; highlighters render `<script>' and `<style>' bodies. `php-only-mode'
;;; handles the `.phps' "PHP source" form, where the buffer is PHP all
;;; the way down with no surrounding HTML.

(define-mode php-mode
  :name "PHP"
  :comment-prefix "// "
  :highlight :php)

(define-mode php-only-mode
  :name "PHP (only)"
  :comment-prefix "// "
  :highlight :php_only)

(register-mode ".php"   php-mode)
(register-mode ".phtml" php-mode)
(register-mode ".phps"  php-only-mode)
