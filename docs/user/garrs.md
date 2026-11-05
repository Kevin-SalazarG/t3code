# Garrs agent team

Garrs is a team of agents that works on your projects together. You talk to
**Garras**, the coordinator, in an ordinary thread. Garras decides whether to
answer directly or open a work item for the team:

- **Asta** plans the work.
- **Pixi** works on the frontend.
- **Botas** works on the backend.
- **Copito** reviews the result independently.
- **Kex** prepares a reviewed commit in an isolated checkout and can request separate approval for a push.

## Turn it on

1. Open **Settings → Garrs**, pick the project, and turn on **Enabled**.
2. Choose the autonomy:
   - **Approve plan** (the default): every plan waits for your approval.
   - **Auto read**: plans that only read run on their own; plans with changes wait.
   - **Auto**: plans run without asking.
3. Optionally list the rule files the team must follow. `AGENTS.md` and
   `CLAUDE.md` are included by default.

Then press **Garrs** in the chat header to open the team as a tab of the right panel, and choose **Start Garras**.
You can also open the team from the command palette or press
**⌘ Option Shift G** on macOS; the shortcut can be changed in keybinding settings.
On mobile, go to **Settings → Projects → (project) → Garrs**.

For work across projects, enable Garrs in each project,
select the related projects under **Settings → Garrs → Project → Associated
projects**, and tell Garras which ones to include. Each task uses its project's
rules and checkout. Changes use a separate worktree for each distinct Git
repository; Copito reviews the combined result and each project's rules.
Each participating project needs a readable Git checkout with a commit so Garrs
can record and compare its state. If a checkout or rule file cannot be verified,
Garrs reports the limitation instead of treating a review as valid.

## Questions stay read-only

When a question ("what do you think?", "is this a bug?", "don't change
anything") needs team work, that work is read-only. Codex uses its operating-system sandbox;
Claude limits the agent to read-only built-in tools and permissions. The T3
server also restricts which T3 MCP tools a read-only team member can call.
These are different kinds of protection: Claude's tool restrictions are not
an operating-system sandbox. The T3 tool filter alone cannot restrict external
MCP servers or other remote actions; each adapter must enforce those separately.

Garrs currently uses only **Claude and Codex**, including additional accounts of
either provider. The restriction applies to the coordinator, members and temporary
helpers. Other providers, including ACP agents such as Kimi and DeepSeek, remain
available in ordinary T3 chats. Existing model preferences are preserved; an
unsupported Garrs preference is reported as unavailable.

| Provider         | Garrs support                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex            | Read-only work and changes in an isolated checkout. Garrs rejects external MCP configuration it cannot verify.                                        |
| Claude Agent SDK | Read-only tools, or changes through Bash in a mandatory native sandbox with an isolated checkout, protected Git metadata and no shell network access. |

For supported providers, Garrs sends the selected instance, model and supported
options. Message acceptance means T3 recorded the message, not that the model
read it. Cancellation cannot undo an external action already performed. Token
and time information depends on what the provider reports.

## Plans and approval

When a plan needs your approval, the team panel shows it with its revision
number. **Approve this plan** approves that exact revision. If Garras asks Asta
to replan before you answer, your approval is refused and the new revision is
shown instead, so you never approve a plan you did not see.

## Review

Changes are reviewed by Copito before Garras can deliver them. A review covers
the Git-tracked and non-ignored untracked changes and configured rule files at
the state assigned to Copito. If that state
changes while Copito is reviewing, or after it approves, that review no longer
counts and a new review is scheduled. You can waive a review from the work item,
and the waiver is recorded.

If Copito cannot complete a review because of missing tools or another operational
blocker, Garras can choose a suitable reviewer within the existing attempt limits.
The completed changes are kept, and the blocked review does not request code corrections.

Changes are made in a separate worktree, so your own uncommitted work in the
project is left alone.

## Models

You do not need to assign a model to every member. Garras reads the available
models, accounts, options, known limits and project restrictions, then records
a task-specific choice and reason. Asta's model suggestions remain proposals
until Garras chooses. Tasks without a decision or a configured preference wait
for Garras; they do not silently take the first catalog model.

Before Garras can reason, T3 selects its startup model separately. It filters
eligible accounts, prefers non-legacy provider defaults from Codex and Claude, and uses a stable
model/account tie-break. This bootstrap is a mechanical choice, not an assessment
of task quality, and appears separately in the team panel.

**Settings → Garrs → Team → How Garras chooses models** accepts optional guidance
such as “prefer Claude for visual work”. Ordered model lists and project overrides
are optional too. A specific task instruction takes priority over preferences;
Garras records its exact quote from your latest message. That verifies the source
of the instruction, not Garras's interpretation. Without such an instruction,
Garras must respect the configured preference order: a later candidate is used
only when the earlier candidates are unavailable and fallback is enabled. The project's allowed-account
list always applies. A manual task reassignment stays pinned without fallback.

Known exhausted limits exclude an account until its reported reset, or for a
short retry hold when the reset is unknown. A catalog entry alone never proves
remaining quota. After an observed usage limit, T3 can use Garras's recorded
permitted alternatives; configured fallback restrictions still apply. Garras's
own conversation can recover in the same thread, with at most two total attempts
per message. Decisions, failures and acceptance into T3's queue remain visible.

Each attempt shows the requested account, model, options, reason and restrictions.
Claude's actual response model can be confirmed when reported consistently.
Session metadata or a requested model alone are not confirmation; missing or
ambiguous identity remains **Not verifiable**.

Claude's read-only roles can read files but cannot run shell commands. A read-only
task that must run tests or inspect Git needs Codex; the model catalog shown to
Garras includes this restriction.

Codex isolates Apps, plugins, hooks, native helpers and external MCP servers for
Garrs threads through temporary configuration. Your ordinary threads and global
preferences stay intact. Garrs refuses to run if it cannot verify the required
tools and restrictions. Codex and Claude shell commands in Garrs have no network access; tasks
that need downloads or network tests must report that restriction.

## Controls

From the work item you can pause, resume, cancel, stop or retry an attempt,
reassign a task to another model, and accept delivered work. **Pause** stops new
attempts from starting; attempts already running finish. **Cancel** asks running
attempts to stop, and each one shows as cancelled once its provider confirms.

Use **Resume**, or ask Garras to continue, to keep the existing plan and completed
results after an interruption. If a stop is still pending, continuation is recorded
and starts automatically after confirmation. It preserves model choices, approval
requirements and attempt limits. Ask for a revision when requirements change.
Direct messages can continue an active member's task; stopped or completed task
threads require continuation through Garras or the team panel.

The work item shows checkout preparation and the validation checks each member
reports. Missing dependencies and dependencies linked outside the checkout are
shown before checks run. Setup scripts are not run automatically. A completed
member task does not mean integration or independent review has passed; required
checks that Copito cannot verify keep the review blocked.

Pixi, Botas, Asta and Copito can request bounded, read-only help for a specific task. The
temporary helper and its requesting task appear in the team activity and usage.
Garrs checks deadlines each minute and asks the provider to stop an expired
helper; the provider must confirm that it stopped.

## Usage

**Settings → Garrs → Usage** lists team attempts and Garras conversation runs
separately, with their tokens and run time when available. A conversation can
cover more than one work item, so its usage is not assigned to a specific task.
Filter by project, date, agent, provider instance or requested model. Export each
list separately as CSV or JSON; the exports mark when the displayed results
were truncated. Exports identify work by ID and omit its free-form title. Values
the provider did not report show as **Unknown**, never as zero. Attempts run in
parallel, so their run times are not added into a total.

When enough token and price data are available, a standard-price estimate is
shown for the requested model. Claude can also report a native CLI estimate
covering a query delta, including auxiliary work. It is shown separately and
marked partial when coverage is incomplete. Resets, overlapping queries or
ambiguous attribution leave it unknown. Neither estimate confirms a subscription
charge; subscription charges remain unknown. Input totals include cache reads
and cache creation, which are also shown separately. Token budgets pause new
assignments after reported usage reaches the limit; an active turn can exceed it.

## Limits

- Cross-project changes require verified, distinct repositories, checkouts and
  rule sources in this environment. Moving or archiving a project blocks new work.
- Ask Garras to prepare a commit. After the writers finish, Garrs stages all
  non-ignored changes in the isolated checkout before Copito reviews them. The team
  panel shows the complete staged diff (up to 64,000 characters), message and branch.
  **Approve and create commit** authorizes that exact tree only.
  If you also request a push, Kex proposes the committed SHA, configured remote and
  destination branch. **Approve and push commit** authorizes that destination separately.
  Changes to the checkout or remote require a new proposal. Push never forces history,
  sends tags or deletes branches. Unknown network outcomes require inspection before retrying.
  This flow supports one project at a time. Multiple push URLs, URL rewrite rules,
  custom transport helpers, clean filters and submodules require manual Git work.
  Existing remote history must be available locally to verify a fast-forward.
  Do not edit the checkout or its rules concurrently with commit approval or execution:
  checks and the branch update are not atomic with external filesystem writes.
- Rule file changes are noticed when a review is checked or work is delivered,
  not continuously.
- Garrs skips project setup scripts and disables local Git hooks for checkout,
  commit and push operations. It rejects configured checkout filters and submodules; changing Git
  configuration concurrently with preparation is not isolated.
- Git-ignored files are outside review state unless explicitly configured as rules.
- The team's tool is visible to every agent in T3 Code; the server refuses it
  in threads that are not part of the team.

## Project integrations

In Settings → Projects, choose a project and open Integrations. Sign in with
Supabase in your browser, authorize access, then choose a Supabase project and a
branch. Add another connection when the project uses several Supabase projects.
Refresh reloads the available projects and branches. Choosing another Supabase
project clears the previous branch selection.

Sign in with GitHub separately and choose a repository from the account's list.
GitHub uses the environment's T3 Code app sign-in, or GitHub CLI when the app sign-in
is not configured. A device sign-in shows the code to enter in the browser.
GitHub and Supabase branch selections are independent.

Credentials and refresh tokens stay in the environment's secret store.
Connections belong to the selected project on its environment. Agents receive
project references and selected branches with their turns and can consult
`project_integrations` for current configuration or live Supabase branches.
Unlink a connection from the same settings section to remove it from the project.
