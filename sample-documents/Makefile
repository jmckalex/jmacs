VERSION = 1.0.2 
ID = 3fb36adc-8ba4-4bbc-bbf2-3d51f01eebe3

.PHONY: bundle
bundle:
	cp css/* bundle/
	cp js/* bundle/
	cp automerge-store.js bundle/
	cp folio-docs.html bundle/
	cp folio-editor.js bundle/
	cp index.html bundle/
	cp main.js bundle/
	cp mdtutorial-content.html bundle/
	cp package.json bundle/
	cp preload.js bundle/
	cp quick-entry-preload.js bundle/
	cp quick-entry.html bundle/
	cp README.md bundle/
	cp folio-editor.js bundle/
	cp CLAUDE.md bundle/
	cp test/function-inventory.js bundle/
	cp vendor/marked-tiptap.js bundle/
	cp vendor/tiptap-build/src/editor.js bundle/


.PHONY: docs
docs:
	@echo "Starting server on http://localhost:8000..."
	@python3 -m http.server 8080 &
	@sleep 1
	@open -a "Google Chrome" http://localhost:8080/folio-docs.html


HEAD = jmckalex@jmckalex.org:/home3/jmckalex/public_html/software/Folio
EXCLUDE =

.PHONY: sync
sync:
	rsync -apvz $(EXCLUDE) $(ARGS) ./folio-docs.html $(HEAD)/

.PHONY: vibe
vibe:
	rsync -apvz $(EXCLUDE) $(ARGS) ./vibe-coding-best-practice.html $(HEAD)/

.PHONY: sign check staple validate dist build-all
sign:
	xcrun notarytool submit dist/Folio-$(VERSION)-arm64.dmg --apple-id "j.mckenzie.alexander@mac.com" --team-id "QC883N4FQC" --password "xcbj-mhpw-jxpo-wnnk"

check:
	xcrun notarytool info $(ID) --apple-id "j.mckenzie.alexander@mac.com" --team-id "QC883N4FQC" --password "xcbj-mhpw-jxpo-wnnk"

staple:
	xcrun stapler staple dist/Folio-$(VERSION)-arm64.dmg

validate:
	xcrun stapler validate dist/Folio-$(VERSION)-arm64.dmg

dist:
	cp dist/Folio-$(VERSION)-arm64.dmg dist/Folio*exe ~/Dropbox/tmp/

build-all:
	npm run build:mac 
	npm run build:win 
	npm run build:linux
	rsync -apvz $(EXCLUDE) $(ARGS) ./dist $(HEAD)/



