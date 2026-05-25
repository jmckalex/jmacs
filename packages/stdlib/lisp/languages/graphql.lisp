;;; graphql.lisp — the GraphQL major mode.

(define-mode graphql-mode
  :name "GraphQL"
  :comment-prefix "# "
  :highlight :graphql)

(register-mode ".graphql" graphql-mode)
(register-mode ".gql"     graphql-mode)
