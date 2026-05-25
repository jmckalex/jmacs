;;; xml.lisp — the XML major mode.

(define-mode xml-mode
  :name "XML"
  :highlight :xml)

(register-mode ".xml"  xml-mode)
(register-mode ".xsd"  xml-mode)
(register-mode ".xsl"  xml-mode)
(register-mode ".xslt" xml-mode)
(register-mode ".svg"  xml-mode)
(register-mode ".plist" xml-mode)
