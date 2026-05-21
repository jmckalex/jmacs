#!/usr/bin/env bash
# scripts/overnight-review.sh
#
# Reviews work done since the most recent overnight recovery tag.

set -euo pipefail

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

# Find the most recent overnight-start tag.
LATEST_TAG=$(git tag -l "overnight-start-*" --sort=-creatordate | head -n 1)

if [[ -z "$LATEST_TAG" ]]; then
  echo -e "${RED}ERROR:${NC} No overnight-start tag found."
  echo "Did you run overnight-prep.sh before the session?"
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
COMMITS_SINCE=$(git rev-list --count "$LATEST_TAG"..HEAD)
FILES_CHANGED=$(git diff --name-only "$LATEST_TAG"..HEAD | wc -l | tr -d ' ')
INSERTIONS=$(git diff --shortstat "$LATEST_TAG"..HEAD | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo "0")
DELETIONS=$(git diff --shortstat "$LATEST_TAG"..HEAD | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' || echo "0")

echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}OVERNIGHT WORK SUMMARY${NC}"
echo -e "${BLUE}=========================================${NC}"
echo ""
echo "Recovery tag:    $LATEST_TAG"
echo "Current branch:  $CURRENT_BRANCH"
echo "Commits made:    $COMMITS_SINCE"
echo "Files changed:   $FILES_CHANGED"
echo "Insertions:      $INSERTIONS"
echo "Deletions:       $DELETIONS"
echo ""

if [[ "$COMMITS_SINCE" -eq 0 ]]; then
  echo -e "${YELLOW}The agent didn't commit anything.${NC}"
  echo "Possible reasons:"
  echo "  - Agent ran into a blocker (check architect-notes.md)"
  echo "  - Agent never started successfully"
  echo "  - Session ended too early"
  echo ""
fi

echo -e "${BLUE}Commits since $LATEST_TAG:${NC}"
git log --oneline --no-decorate "$LATEST_TAG"..HEAD
echo ""

if [[ -f "architect-notes.md" ]]; then
  RECENT_NOTES=$(grep -c "^## \[" architect-notes.md 2>/dev/null || echo "0")
  if [[ "$RECENT_NOTES" -gt 0 ]]; then
    echo -e "${YELLOW}There are notes in architect-notes.md to review.${NC}"
    echo "Latest entries:"
    echo ""
    tail -n 50 architect-notes.md
    echo ""
  fi
fi

echo -e "${BLUE}Running tests to verify current state...${NC}"
if [[ -f "package.json" ]] && grep -q '"test"' package.json; then
  if pnpm test --silent > /tmp/test-output.log 2>&1; then
    echo -e "${GREEN}Tests are passing.${NC}"
  else
    echo -e "${RED}Tests are FAILING on current state.${NC}"
    echo "Last 30 lines of test output:"
    tail -n 30 /tmp/test-output.log
    echo ""
  fi
fi
echo ""

echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}YOUR OPTIONS${NC}"
echo -e "${BLUE}=========================================${NC}"
echo ""
echo "Review full diff:"
echo "    git diff $LATEST_TAG..HEAD"
echo ""
echo "Review file-by-file:"
echo "    git diff $LATEST_TAG..HEAD -- <path>"
echo ""
echo "Keep everything and merge to main:"
echo "    git checkout main && git merge --no-ff $CURRENT_BRANCH"
echo ""
echo "Selectively keep commits:"
echo "    git rebase -i $LATEST_TAG"
echo ""
echo "Throw it all away:"
echo "    git reset --hard $LATEST_TAG"
echo ""
echo "Keep changes but uncommit them:"
echo "    git reset --soft $LATEST_TAG"
echo ""
echo "Clean up the recovery tag when done:"
echo "    git tag -d $LATEST_TAG"
echo ""
