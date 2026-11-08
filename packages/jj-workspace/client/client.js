// Client half of dsh-jj-workspace: the new-session worktree option replaced
// with a VCS-aware control, plus a compact task-state pill in the Session
// header. The control shadows the stock Forge toggle only in the slot cell
// (`forge-panel.worktree`, priority -1), so unloading this plugin restores the
// stock control. Requests still go through the stock Forge Remote, which keeps
// the first-message hold, progress card, retry, and withdraw lifecycle.
window.__ModuleLoader__.load({
  id: "dsh-jj-workspace",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    var LOCALE_NS = "jj-workspace";
    var RPC_BASE = "/dsh-jj-workspace";
    var TASK_REFRESH_MS = 10000;
    var STATUS_RETRY_MS = 2000;

    var en = {
      jj: "jj workspace",
      git: "worktree",
      hintJj: "Create a jj workspace from the current change and enter it for this session.",
      hintGit: "Create a Git worktree from the selected branch and enter it for this session.",
      requested: "The workspace is created before the first message.",
      baseAt: "current change (@)",
      baseCurrent: "{name} (current)",
      baseHead: "HEAD",
      detached: "detached {commit}",
      blockerReadOnly: "This session is read-only.",
      blockerOutside: "The project pool is outside this session's writable root.",
      blockerJj: "jj cannot read this workspace.",
      blockerNotGit: "This directory is not a Git checkout.",
      failed: "Workspace request failed: {message}",
      taskOk: "jj: {name}",
      taskMoved: "{name} (moved)",
      taskBookmarkMissing: "{name} (bookmark missing)",
      taskWorkspaceMissing: "{name} (workspace missing)",
      taskConflict: "{name} (conflict)",
      taskUnavailable: "{name} (unavailable)",
      taskDetail: "{workspace} at {path}\nbookmark {bookmark} at {change}\nbase {base}\nstate: {state}"
    };
    var zh = {
      jj: "jj 工作区",
      git: "工作树",
      hintJj: "从当前 change 创建 jj 工作区，并让本会话在其中工作。",
      hintGit: "从所选分支创建 Git 工作树，并让本会话在其中工作。",
      requested: "首条消息发送前会创建工作区。",
      baseAt: "当前 change (@)",
      baseCurrent: "{name}（当前）",
      baseHead: "HEAD",
      detached: "detached {commit}",
      blockerReadOnly: "本会话是只读的。",
      blockerOutside: "项目池不在本会话的可写根内。",
      blockerJj: "jj 无法读取该工作区。",
      blockerNotGit: "当前目录不是 Git 检出。",
      failed: "工作区请求失败：{message}",
      taskOk: "jj：{name}",
      taskMoved: "{name}（已移动）",
      taskBookmarkMissing: "{name}（bookmark 缺失）",
      taskWorkspaceMissing: "{name}（workspace 缺失）",
      taskConflict: "{name}（冲突）",
      taskUnavailable: "{name}（不可读）",
      taskDetail: "{workspace} 位于 {path}\nbookmark {bookmark} 指向 {change}\nbase {base}\n状态：{state}"
    };

    var STYLE_ID = "dsh-jj-workspace/toggle.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-jj-workspace";
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = ".dsh-jjw-root{display:inline-flex;align-items:center;gap:4px;min-width:0}.dsh-jjw-toggle{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 8px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer;font-size:13px;font-weight:500;line-height:20px;user-select:none}.dsh-jjw-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-jjw-toggle[data-disabled]{cursor:default;color:var(--dsw-alias-label-dimmed)}.dsh-jjw-toggle input{width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-brand-primary);flex:none}.dsh-jjw-base{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;max-width:200px;min-height:28px;padding:0 4px;cursor:pointer}.dsh-jjw-base:disabled{cursor:default}.dsh-jjw-current{color:var(--dsw-alias-label-tertiary);font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-jjw-error{max-width:240px;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-state-error-primary);font-size:12px;font-weight:400}.dsh-jjw-task{display:inline-flex;align-items:center;gap:6px;max-width:180px;height:28px;padding:0 8px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default}.dsh-jjw-task .dsh-jjw-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}.dsh-jjw-task[data-state=ok] .dsh-jjw-dot{background:var(--dsw-alias-state-success-primary)}.dsh-jjw-task[data-state=moved] .dsh-jjw-dot{background:var(--dsw-alias-state-warning-primary)}.dsh-jjw-task[data-state=bookmark-missing] .dsh-jjw-dot,.dsh-jjw-task[data-state=workspace-missing] .dsh-jjw-dot,.dsh-jjw-task[data-state=conflict] .dsh-jjw-dot{background:var(--dsw-alias-state-error-primary)}@media (pointer:coarse){.dsh-jjw-toggle{min-height:44px}.dsh-jjw-task{height:36px}}";
      document.head.appendChild(tag);
    }

    var rpcSeq = 0;
    function call(sessionId, method, signal) {
      rpcSeq += 1;
      return fetch(RPC_BASE + "/" + method, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "client-request",
          rpcId: "jj-workspace-" + method + "-" + String(rpcSeq),
          method: method,
          payload: { sessionId: sessionId }
        }),
        signal: signal
      }).then(function (response) {
        if (!response.ok) return null;
        return response.json();
      }).then(function (envelope) {
        if (!envelope || envelope.type !== "server-response" || !envelope.result || !envelope.result.ok) return null;
        return envelope.result.value;
      });
    }

    function blockerText(t, blocker) {
      if (blocker === "read-only") return t("blockerReadOnly");
      if (blocker === "outside-writable-root") return t("blockerOutside");
      if (blocker === "jj-unavailable") return t("blockerJj");
      if (blocker === "not-git") return t("blockerNotGit");
      return "";
    }

    function Toggle(props) {
      var sessionId = props.sessionId;
      var t = props.t;
      var request = props.request;
      var cancel = props.cancel;
      var status = props.status;
      var follow = props.follow;
      var branches = props.branches;
      var useProjection = props.useProjection;
      var permissions = useProjection("permissions");
      var permissionValue = permissions && permissions.currentValue;

      var panelPair = React.useState(null);
      var panel = panelPair[0];
      var setPanel = panelPair[1];
      var statusPair = React.useState(null);
      var statusState = statusPair[0];
      var setStatusState = statusPair[1];
      var branchesPair = React.useState(null);
      var branchList = branchesPair[0];
      var setBranchList = branchesPair[1];
      var pendingPair = React.useState(false);
      var pending = pendingPair[0];
      var setPending = pendingPair[1];
      var errorPair = React.useState("");
      var error = errorPair[0];
      var setError = errorPair[1];

      // The panel stream carries the stock worktree state (editable, request,
      // created, creation, blocker) and the checkout facts. It is the same
      // public state the stock toggle reads.
      React.useEffect(function () {
        var alive = true;
        var controller;
        var timer;
        var start = function () {
          if (!alive) return;
          controller = new AbortController();
          (async function () {
            try {
              var stream = follow(controller.signal);
              for await (var frame of stream) {
                if (alive) setPanel(frame);
              }
            } catch (failure) {
              // A transport reset or a disposed Remote; retry while mounted.
            }
            if (alive) timer = setTimeout(start, 2000);
          })();
        };
        start();
        return function () {
          alive = false;
          if (controller) controller.abort();
          if (timer) clearTimeout(timer);
        };
      }, [sessionId]);

      var worktree = panel && panel.worktree;
      var created = !!(worktree && worktree.created);
      var directory = panel && panel.directory;

      React.useEffect(function () {
        if (created || !worktree || !worktree.editable) {
          setStatusState(null);
          return undefined;
        }
        var alive = true;
        var controller;
        var timer;
        var schedule = function () {
          if (!alive) return;
          setStatusState(null);
          timer = setTimeout(load, STATUS_RETRY_MS);
        };
        var load = function () {
          if (!alive) return;
          controller = new AbortController();
          status(sessionId, controller.signal).then(function (next) {
            if (!alive) return;
            if (next === null) schedule();
            else setStatusState(next);
          }, function () {
            schedule();
          });
        };
        // Invalidate the old VCS/permission answer before asking again: a new
        // directory, Session, or permission value must not keep old semantics.
        setStatusState(null);
        setBranchList(null);
        load();
        return function () {
          alive = false;
          if (controller) controller.abort();
          if (timer) clearTimeout(timer);
        };
      }, [sessionId, directory, created, worktree && worktree.editable, permissionValue]);

      var requested = !!(worktree && worktree.request !== null);
      var kind = statusState && statusState.kind;
      var jj = kind === "jj";
      var gitBlocker = worktree ? worktree.blocker : null;
      var blocker = jj
        ? statusState.blocker === undefined ? null : statusState.blocker
        : gitBlocker === undefined ? null : gitBlocker;
      var usable = blocker === null;
      var checkout = panel && panel.checkout;
      var currentBranch = !jj && checkout && checkout.state === "ready" && checkout.checkout.branch ? checkout.checkout.branch : null;
      var currentCommit = !jj && checkout && checkout.state === "ready" && checkout.checkout.commit ? checkout.checkout.commit : null;

      // Only the Git arm needs the stock branch list; the jj arm uses the
      // status channel's local bookmark names. Keep this hook before every
      // conditional return so the hook order never changes.
      React.useEffect(function () {
        if (kind !== "git" || !requested || !usable || branchList !== null) return undefined;
        var alive = true;
        branches().then(function (result) {
          if (alive && result && result.ok) setBranchList(result.value);
        }, function () {});
        return function () {
          alive = false;
        };
      }, [kind, requested, usable, branchList]);

      if (!worktree || created || !worktree.editable) return null;
      if (!kind || kind === "none") return null;
      if (!jj) {
        if (!checkout || checkout.state !== "ready") return null;
        if (worktree.blocker === "not-git") return null;
      }
      var creation = worktree.creation;
      var held = creation !== null;
      var disabled = held || pending || (!usable && !requested);
      var from = requested ? worktree.request.from : null;
      var baseValue = jj ? (from === null ? "@" : from) : (from === null ? currentBranch : from);
      var baseText = jj
        ? (from === null ? t("baseAt") : from)
        : from !== null
          ? from
          : requested
            ? t("baseHead")
            : currentBranch !== null
              ? currentBranch
              : t("detached", { commit: currentCommit || "?" });
      var reason = error || blockerText(t, blocker);
      var hint = reason || (requested ? t("requested") : jj ? t("hintJj") : t("hintGit"));

      var change = function (checked) {
        if (pending || disabled) return;
        setPending(true);
        setError("");
        var next = checked ? (jj ? null : currentBranch) : null;
        var operation = checked ? request(next) : cancel();
        operation.then(function (result) {
          if (!result || result.ok !== true) {
            var message = result && result.error && result.error.message ? result.error.message : "unknown error";
            setError(t("failed", { message: message }));
          }
        }, function (failure) {
          setError(t("failed", { message: String(failure && failure.message ? failure.message : failure) }));
        }).then(function () {
          setPending(false);
        });
      };

      var pick = function (value) {
        if (pending || held) return;
        setPending(true);
        setError("");
        var next = value === "" || (jj && value === "@") ? null : value;
        request(next).then(function (result) {
          if (!result || result.ok !== true) {
            var message = result && result.error && result.error.message ? result.error.message : "unknown error";
            setError(t("failed", { message: message }));
          }
        }, function (failure) {
          setError(t("failed", { message: String(failure && failure.message ? failure.message : failure) }));
        }).then(function () {
          setPending(false);
        });
      };

      var base = null;
      if (requested && usable) {
        var options;
        if (jj) {
          var names = (statusState.bookmarks || []).slice();
          if (from !== null && names.indexOf(from) === -1) names.unshift(from);
          options = ["@"].concat(names);
        } else {
          var listed = branchList && Array.isArray(branchList.branches) ? branchList.branches.slice() : [];
          if (from !== null && listed.indexOf(from) === -1) listed.unshift(from);
          if (currentBranch !== null && listed.indexOf(currentBranch) === -1) listed.unshift(currentBranch);
          options = currentBranch === null && baseValue === "" ? [""].concat(listed) : listed;
        }
        base = React.createElement("select", {
          className: "dsh-jjw-base",
          value: baseValue === null ? "" : baseValue,
          disabled: pending || held,
          onChange: function (event) {
            pick(event.currentTarget.value);
          }
        }, options.map(function (name) {
          var label = name === "@"
            ? t("baseAt")
            : name === ""
              ? t("detached", { commit: currentCommit || "?" })
              : !jj && name === currentBranch
                ? t("baseCurrent", { name: name })
                : name;
          return React.createElement("option", { key: name, value: name }, label);
        }));
      } else {
        base = React.createElement("span", { className: "dsh-jjw-current", title: hint }, baseText);
      }

      return React.createElement("span", {
        className: "dsh-jjw-root",
        "data-jj-workspace-toggle": "",
        "data-vcs": jj ? "jj" : "git"
      },
        base,
        React.createElement("label", {
          className: "dsh-jjw-toggle",
          "data-disabled": disabled ? "" : undefined,
          title: hint
        },
          React.createElement("input", {
            type: "checkbox",
            checked: requested,
            disabled: disabled,
            onChange: function (event) {
              change(event.currentTarget.checked);
            }
          }),
          React.createElement("span", null, jj ? t("jj") : t("git"))
        ),
        error ? React.createElement("span", { className: "dsh-jjw-error", role: "alert" }, error) : null
      );
    }

    function TaskPill(props) {
      var sessionId = props.sessionId;
      var t = props.t;
      var tasks = props.tasks;
      var listPair = React.useState(null);
      var list = listPair[0];
      var setList = listPair[1];

      React.useEffect(function () {
        var alive = true;
        var load = function () {
          tasks(sessionId).then(function (value) {
            if (alive) setList(value && Array.isArray(value.tasks) ? value.tasks : []);
          }, function () {
            if (alive) setList([]);
          });
        };
        load();
        var timer = setInterval(load, TASK_REFRESH_MS);
        return function () {
          alive = false;
          clearInterval(timer);
        };
      }, [sessionId]);

      if (!list || list.length === 0) return null;
      var task = list[list.length - 1];
      var state = task.state || "unavailable";
      var labelKey = state === "ok"
        ? "taskOk"
        : state === "moved"
          ? "taskMoved"
          : state === "bookmark-missing"
            ? "taskBookmarkMissing"
            : state === "workspace-missing"
              ? "taskWorkspaceMissing"
              : state === "conflict"
                ? "taskConflict"
                : "taskUnavailable";
      return React.createElement("span", {
        className: "dsh-jjw-task",
        "data-state": state,
        title: t("taskDetail", {
          workspace: task.workspace,
          path: task.path,
          bookmark: task.bookmark,
          change: task.currentChangeId || task.changeId,
          base: task.baseChange,
          state: state
        })
      },
        React.createElement("span", { className: "dsh-jjw-dot" }),
        t(labelKey, { name: task.workspace })
      );
    }

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(LOCALE_NS, { en: en, zh: zh });
      }, "dsh-jj-workspace: locale");
      var t = ctx.locale.bind(LOCALE_NS);

      ctx.inject(["remote.forgePanel"], function (scope) {
        scope.slots.inject("conversation.hero.options", function () {
          return scope.slots.register({
            name: "conversation.hero.options",
            id: "forge-panel.worktree",
            priority: -1,
            order: 0,
            locale: LOCALE_NS,
            inject: function (sessionId) {
              return {
                t: t,
                status: function (id, signal) {
                  return call(id, "status", signal);
                },
                follow: function (signal) {
                  return scope.remote.forgePanel.follow(sessionId, signal);
                },
                branches: function () {
                  return scope.remote.forgePanel.branches(sessionId);
                },
                request: function (from) {
                  return scope.remote.forgePanel.requestWorktree(sessionId, from);
                },
                cancel: function () {
                  return scope.remote.forgePanel.cancelWorktree(sessionId);
                }
              };
            }
          }, Toggle);
        });
      });

      ctx.slots.inject("conversation.session.header.utilities", function () {
        return ctx.slots.register({
          name: "conversation.session.header.utilities",
          id: "jj-workspace.task",
          order: -7,
          locale: LOCALE_NS,
          inject: function (sessionId) {
            return {
              t: t,
              tasks: function () {
                return call(sessionId, "tasks", undefined);
              }
            };
          }
        }, TaskPill);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale", "remote"];
    return module.exports;
  }
});
