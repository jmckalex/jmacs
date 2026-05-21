#!/usr/bin/env bash
# scripts/overnight-prep.sh
#
# Prepares the project for an overnight unsupervised Claude Code run.
#
# Usage: ./scripts/overnight-prep.sh <agent-branch-name>
# Example: ./scripts/overnight-prep.sh agent-1-storage

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

if [[ $# -lt 1 ]]; then
  echo -e "${RED}ERROR:${NC} Agent branch name required."
  echo "Usage: $0 <agent-branch-name>"
  echo "Example: $0 agent-1-storage"
  exit 1
fi

AGENT_BRANCH="$1"
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
RECOVERY_TAG="overnight-start-${TIMESTAMP}"

# Step 1: Working tree must be clean.
echo -e "${BLUE}Step 1: Checking working tree...${NC}"
if [[ -n "$(git status --porcelain)" ]]; then
  echo -e "${RED}ERROR:${NC} Working tree not clean. Commit or stash first."
  git status --short
  exit 1
fi
echo -e "${GREEN}Working tree clean.${NC}"
echo ""

# Step 2: Show current branch.
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo -e "${BLUE}Step 2: Current branch is '$CURRENT_BRANCH'.${NC}"

# Step 3: Switch to or create agent branch.
echo -e "${BLUE}Step 3: Setting up agent branch '$AGENT_BRANCH'...${NC}"
if git show-ref --verify --quiet "refs/heads/$AGENT_BRANCH"; then
  echo "Branch '$AGENT_BRANCH' exists. Switching."
  git checkout "$AGENT_BRANCH"
else
  echo "Branch '$AGENT_BRANCH' doesn't exist. Creating from current HEAD."
  git checkout -b "$AGENT_BRANCH"
fi
echo ""

# Step 4: Tag the starting commit.
echo -e "${BLUE}Step 4: Tagging recovery point as '$RECOVERY_TAG'...${NC}"
git tag -a "$RECOVERY_TAG" -m "Recovery point before overnight run starting $TIMESTAMP on branch $AGENT_BRANCH"
echo -e "${GREEN}Tagged $(git rev-parse --short HEAD) as $RECOVERY_TAG.${NC}"
echo ""

# Step 5: Run tests.
echo -e "${BLUE}Step 5: Running tests on starting state...${NC}"
if [[ -f "package.json" ]] && grep -q '"test"' package.json; then
  if ! pnpm test --silent; then
    echo -e "${RED}ERROR:${NC} Tests failing on starting state."
    echo "Fix tests before starting overnight, or you won't know what the agent broke."
    git tag -d "$RECOVERY_TAG"
    exit 1
  fi
  echo -e "${GREEN}Tests passing on starting state.${NC}"
else
  echo -e "${YELLOW}WARNING:${NC} No test script found. Skipping. Risky for overnight runs."
fi
echo ""

# Step 6: Verify Claude Code config.
echo -e "${BLUE}Step 6: Sanity-checking Claude Code configuration...${NC}"
if [[ ! -f ".claude/settings.json" ]]; then
  echo -e "${RED}ERROR:${NC} No .claude/settings.json. Cannot run safely overnight."
  git tag -d "$RECOVERY_TAG"
  exit 1
fi

if [[ -f ".claude/settings.local.json" ]]; then
  if grep -q '"bypassPermissions"' .claude/settings.local.json; then
    echo -e "${YELLOW}NOTE:${NC} .claude/settings.local.json has bypassPermissions mode."
    echo "This is intended for overnight runs, but REMEMBER to revert"
    echo "to 'ask' mode after the run completes."
  fi
fi
echo -e "${GREEN}Configuration looks reasonable.${NC}"
echo ""

# Step 7: Initialise session notes.
echo -e "${BLUE}Step 7: Initialising session notes...${NC}"
if [[ ! -f "architect-notes.md" ]]; then
  cat > architect-notes.md <<'EOF'
# Architect Notes

Notes from sub-agents flagging questions, blockers, or decisions for review.

EOF
fi

cat >> architect-notes.md <<EOF

---

# Overnight Session: $TIMESTAMP

- **Branch**: $AGENT_BRANCH
- **Recovery tag**: $RECOVERY_TAG
- **Started from commit**: $(git rev-parse --short HEAD)

EOF
echo -e "${GREEN}Session notes initialised.${NC}"
echo ""

# Step 8: Print recovery instructions.
echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}OVERNIGHT RUN READY${NC}"
echo -e "${BLUE}=========================================${NC}"
echo ""
echo "Branch:        $AGENT_BRANCH"
echo "Recovery tag:  $RECOVERY_TAG"
echo "Start commit:  $(git rev-parse --short HEAD)"
echo ""
echo -e "${YELLOW}In the morning, your recovery options:${NC}"
echo ""
echo "  Review what the agent did:"
echo "    git log $RECOVERY_TAG..HEAD --oneline"
echo "    git diff $RECOVERY_TAG..HEAD"
echo ""
echo "  Keep some commits, drop others:"
echo "    git reset --soft $RECOVERY_TAG"
echo "    # then stage and commit selectively"
echo ""
echo "  Throw it all away:"
echo "    git reset --hard $RECOVERY_TAG"
echo ""
echo "  Keep everything and merge to main:"
echo "    git checkout main"
echo "    git merge --no-ff $AGENT_BRANCH"
echo ""
echo "  See agent's notes:"
echo "    cat architect-notes.md"
echo ""
echo -e "${GREEN}Now launch Claude Code with the agent prompt.${NC}"
echo ""
