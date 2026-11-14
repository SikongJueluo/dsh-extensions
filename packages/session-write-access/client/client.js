// Client half of dsh-session-write-access.
//
// Two additive slots:
//   - `conversation.input.left`: a compact write-scope button beside the stock
//     composer controls (never replacing the permission control);
//   - `shell.overlay`: the panel itself, in the frame-wide floating layer, so
//     it is not clipped by the docked composer.
//
// The panel is the user-only management surface: add a directory, allow/deny
// a persistent Agent request, revoke a grant, or fork this session with its
// current grants. All decisions are posted to this package's same-origin
// route; the host re-validates every path and never accepts a browser-supplied
// actor.
//
// Plain JavaScript (no JSX), evaluated by the DSH client module loader.
window.__ModuleLoader__.load({
  id: "dsh-session-write-access",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var h = React.createElement;

    var NS = "session-write-access";
    var RPC = "/dsh-session-write-access";

    var en = {
      panel: "Write scope",
      panelCompact: "{dirs} dirs",
      panelPending: "{n} pending",
      title: "Write scope",
      close: "Close",
      mode: "Mode",
      workspace: "Workspace",
      deploymentRoots: "Deployment directories",
      deploymentNote: "Granted by the deployment; not revocable here.",
      grants: "Extra writable directories",
      noGrants: "No extra directory yet. The workspace above is writable.",
      sourceUser: "user",
      sourceFork: "forked",
      coveredBy: "still writable via {path}",
      revoke: "Revoke",
      confirmRevoke: "Confirm revoke",
      pendingTitle: "Pending requests",
      noPending: "No pending request.",
      allow: "Allow",
      deny: "Deny",
      requestedBy: "requested by {session}",
      addTitle: "Add a directory",
      addPlaceholder: "Absolute path of an existing directory",
      add: "Add",
      pick: "Choose directory",
      forkTitle: "Fork with grants",
      fork: "Fork and inherit grants",
      forkNote: "Copies the directories granted at click time into an independent group. The stock Fork button does NOT inherit these directories; it keeps only the workspace and deployment roots.",
      oldProcessNote: "New grants apply to new calls. Shells and background processes already running keep the permissions they started with; revoking does not terminate them.",
      error: "Failed: {message}",
      loading: "Loading…",
      refresh: "Refresh",
      forkCreated: "Forked session {id} is now open.",
      forkFailed: "Fork failed: {message}",
      forkPreviousFailed: "The previous Fork did not finish. Any session it created has only the default workspace and did not inherit grants.",
      forkSeq: "Event seq (optional)",
      notAttributed: "This session has no write-access group yet. Send a message or reopen the session, then retry.",
      recent: "Recent decisions",
      reason: "Reason",
      session: "session",
      allowNote: "Allows this session and its local subagents to create, modify, and delete files under this directory and its subdirectories until revoked.",
      empty: "—",
      alreadyCovered: "Already writable via {path}.",
    };

    var zh = {
      panel: "写入范围",
      panelCompact: "{dirs} 个目录",
      panelPending: "{n} 项待确认",
      title: "写入范围",
      close: "关闭",
      mode: "模式",
      workspace: "工作区",
      deploymentRoots: "部署级目录",
      deploymentNote: "由部署配置授予，此处不可撤销。",
      grants: "额外可写目录",
      noGrants: "还没有额外目录。上方工作区可写。",
      sourceUser: "用户授权",
      sourceFork: "Fork 继承",
      coveredBy: "仍可经 {path} 写入",
      revoke: "撤销",
      confirmRevoke: "确认撤销",
      pendingTitle: "待确认申请",
      noPending: "没有待确认申请。",
      allow: "允许",
      deny: "拒绝",
      requestedBy: "由 {session} 申请",
      addTitle: "添加目录",
      addPlaceholder: "已存在目录的绝对路径",
      add: "添加",
      pick: "选择目录",
      forkTitle: "Fork 并继承授权",
      fork: "Fork 并继承授权",
      forkNote: "把点击时有效的额外目录复制到一个独立授权组。原生 Fork 按钮不会继承这些目录，只保留工作区与部署级目录。",
      oldProcessNote: "新授权对后续调用生效。已经运行的终端和后台进程保留启动时的权限；撤销不会终止它们。",
      error: "操作失败：{message}",
      loading: "加载中…",
      refresh: "刷新",
      forkCreated: "已创建并打开会话 {id}。",
      forkFailed: "Fork 失败：{message}",
      forkPreviousFailed: "上次 Fork 未完成。若已创建会话，它只有默认工作区，未继承授权。",
      forkSeq: "事件序号（可选）",
      notAttributed: "此会话还没有写入授权组。请先发送消息或重新打开会话后重试。",
      recent: "最近决定",
      reason: "理由",
      session: "会话",
      allowNote: "允许此会话及其本地子 Agent 在该目录及子目录内新建、修改、删除文件，直到撤销。",
      empty: "—",
      alreadyCovered: "Already writable via {path}.",
    };

    var stylesCss = [      ".dswa-panel-button{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l4, rgba(255,255,255,.16));border-radius:10px;background:var(--dsw-alias-bg-module-platform, rgba(255,255,255,.04));color:var(--dsw-alias-label-secondary, #c8c8ce);font:inherit;font-size:12px;line-height:16px;cursor:pointer}",
      ".dswa-panel-button:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.10))}",
      ".dswa-badge{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--dsw-alias-button-info-fill, #8ab4ff);color:#0b1220;font-size:11px;line-height:18px;text-align:center;font-weight:600}",
      ".dswa-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.45);pointer-events:auto}",
      ".dswa-dialog{width:min(640px,94vw);max-height:86vh;overflow:auto;border:1px solid var(--dsw-alias-border-l4, rgba(255,255,255,.16));border-radius:16px;background:var(--dsw-alias-bg-module-platform, #17171b);color:var(--dsw-alias-label-primary, #e8e8ea);box-shadow:0 18px 60px rgba(0,0,0,.45);padding:18px 20px 20px}",
      ".dswa-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}",
      ".dswa-title{font-size:16px;font-weight:600;line-height:22px;margin:0}",
      ".dswa-x{border:none;background:transparent;color:var(--dsw-alias-label-tertiary, #9a9aa2);font-size:20px;line-height:24px;cursor:pointer;min-width:44px;min-height:44px}",
      ".dswa-grid{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:12px;line-height:18px;margin-bottom:14px}",
      ".dswa-key{color:var(--dsw-alias-label-tertiary, #9a9aa2)}",
      ".dswa-value{word-break:break-all}",
      ".dswa-section{margin:16px 0 0}",
      ".dswa-section h3{font-size:13px;line-height:18px;margin:0 0 8px;font-weight:600}",
      ".dswa-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid var(--dswa-border, rgba(255,255,255,.08))}",
      ".dswa-row:first-of-type{border-top:none}",
      ".dswa-path{font-size:12px;line-height:18px;word-break:break-all}",
      ".dswa-sub{font-size:11px;line-height:16px;color:var(--dswa-tertiary, #9a9aa2);margin-top:2px}",
      ".dswa-tag{display:inline-block;margin-left:6px;padding:0 6px;border-radius:6px;background:var(--dswa-tag-bg, rgba(255,255,255,.08));font-size:10px;line-height:16px;color:var(--dswa-tertiary, #9a9aa2)}",
      ".dswa-btn{border:1px solid var(--dswa-border, rgba(255,255,255,.16));border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:16px;padding:6px 10px;cursor:pointer;min-height:32px}",
      ".dswa-btn:hover{background:var(--dswa-hover, rgba(255,255,255,.08))}",
      ".dswa-btn-primary{background:var(--dswa-primary, #8ab4ff);border-color:transparent;color:#0b1220;font-weight:600}",
      ".dswa-btn-danger{color:var(--dswa-danger, #f2727a)}",
      ".dswa-input{flex:1;min-width:0;font:inherit;font-size:12px;line-height:16px;padding:7px 9px;border-radius:8px;border:1px solid var(--dswa-border, rgba(255,255,255,.16));background:var(--dswa-input-bg, rgba(255,255,255,.04));color:inherit;outline:none}",
      ".dswa-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
      ".dswa-error{font-size:12px;line-height:18px;color:var(--dswa-danger, #f2727a);margin-top:10px;white-space:pre-wrap}",
      ".dswa-note{font-size:11px;line-height:16px;color:var(--dswa-tertiary, #9a9aa2);margin-top:8px}",
      ".dswa-empty{font-size:12px;line-height:18px;color:var(--dswa-tertiary, #9a9aa2)}",
      "@media (pointer: coarse){.dswa-panel-button{min-height:44px}.dswa-btn{min-height:44px}.dswa-x{min-width:44px;min-height:44px}}"
    ].join("\n");

    /** Package-owned stylesheet, removed with the client run. */
    function insertStyles(css) {
      var tag = document.createElement("style");
      tag.setAttribute("data-dsh-session-write-access", "");
      tag.textContent = css;
      document.head.appendChild(tag);
      return function () { tag.remove(); };
    }

    // --- module-level panel state (two slots share it) ---
    var S = { open: false, sessionId: null, view: null, busy: false, error: null, notice: null, listeners: [] };

    function setState(patch) {
      Object.assign(S, patch);
      S.listeners.slice().forEach(function (listener) { listener(); });
    }

    function subscribe(listener) {
      S.listeners.push(listener);
      return function () {
        var index = S.listeners.indexOf(listener);
        if (index >= 0) S.listeners.splice(index, 1);
      };
    }

    function useShared() {
      var pair = React.useState(0);
      var force = pair[1];
      React.useEffect(function () {
        return subscribe(function () { force(function (value) { return value + 1; }); });
      }, []);
      return S;
    }

    function rpc(method, args) {
      return fetch(RPC, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.assign({ method: method }, args))
      }).then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      }).then(function (envelope) {
        if (!envelope || envelope.ok !== true) {
          throw new Error(envelope && envelope.error ? envelope.error.message : "invalid response");
        }
        return envelope.value;
      });
    }

    function messageOf(error) {
      return error && error.message ? error.message : String(error);
    }

    function format(t, key, values) {
      return t(key, values);
    }

    function apply(ctx) {
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "session-write-access: locale");
      ctx.effect(function () { return insertStyles(stylesCss); }, "session-write-access: styles");      var t = ctx.locale.bind(NS);
      var workspaceClient = ctx.get("uiWorkspace");

      function refresh() {
        var sessionId = S.sessionId;
        if (!sessionId) return Promise.resolve();
        setState({ busy: true, error: null });
        return rpc("state", { sessionId: sessionId }).then(function (view) {
          if (S.sessionId === sessionId) setState({ view: view, busy: false });
        }).catch(function (error) {
          setState({ busy: false, error: messageOf(error) });
        });
      }

      function mutate(method, extra) {
        var sessionId = S.sessionId;
        setState({ busy: true, error: null, notice: null });
        return rpc(method, Object.assign({ sessionId: sessionId }, extra)).then(function (view) {
          if (S.sessionId === sessionId) {
            setState({
              view: view,
              busy: false,
              notice: view && view.coveredBy ? format(t, "alreadyCovered", { path: view.coveredBy }) : null
            });
          }
          return view;
        }).catch(function (error) {
          setState({ busy: false, error: messageOf(error) });
          throw error;
        });
      }

      function fork(atSeq) {
        var sessionId = S.sessionId;
        setState({ busy: true, error: null, notice: null });
        var args = { sessionId: sessionId };
        if (typeof atSeq === "number") args.atSeq = atSeq;
        return rpc("fork", args).then(function (created) {
          setState({ busy: false, notice: format(t, "forkCreated", { id: created.sessionId }) });
          if (workspaceClient && typeof workspaceClient.openSession === "function") {
            workspaceClient.openSession(created.sessionId);
          }
          return refresh();
        }).catch(function (error) {
          setState({ busy: false, error: format(t, "forkFailed", { message: messageOf(error) }) });
        });
      }

      function PanelButton(props) {
        var shared = useShared();
        var dirs = shared.view && shared.view.grants ? shared.view.grants.length : 0;
        var pending = shared.view && shared.view.pending ? shared.view.pending.length : 0;
        React.useEffect(function () {
          if (!props.sessionId) return undefined;
          if (S.open && S.sessionId !== props.sessionId) {
            setState({ sessionId: props.sessionId, view: null });
            refresh();
          } else if (!S.open) {
            // Keep the compact count current without opening the panel.
            setState({ sessionId: props.sessionId });
            rpc("state", { sessionId: props.sessionId }).then(function (view) {
              if (!S.open && S.sessionId === props.sessionId) setState({ view: view });
            }).catch(function () { /* unattributed sessions simply show no counts */ });
          }
          return undefined;
        }, [props.sessionId, shared.open]);
        return h("button", {
          type: "button",
          className: "dswa-panel-button",
          title: t("panel"),
          "aria-label": t("panel"),
          onClick: function () {
            setState({ open: true, sessionId: props.sessionId, view: null, error: null, notice: null });
            refresh();
          }
        },
          h("span", null, t("panelCompact", { dirs: dirs })),
          pending > 0 ? h("span", { className: "dswa-badge" }, String(pending)) : null
        );
      }

      function Overlay() {
        var shared = useShared();
        var input = React.useState("");
        var path = input[0];
        var setPath = input[1];
        var confirmState = React.useState(null);
        var confirmPath = confirmState[0];
        var setConfirmPath = confirmState[1];
        var seqState = React.useState("");
        var forkSeq = seqState[0];
        var setForkSeq = seqState[1];
        React.useEffect(function () {
          if (!shared.open) {
            setConfirmPath(null);
            setPath("");
          }
        }, [shared.open]);
        if (!shared.open) return null;
        var view = shared.view;
        var busy = shared.busy;
        var grants = view ? view.grants : [];
        var pending = view ? view.pending : [];
        var recent = view ? view.recent : [];
        var errorText = shared.error;
        var noticeText = shared.notice;

        function close() { setState({ open: false, error: null, notice: null }); }

        function choose() {
          if (!workspaceClient || typeof workspaceClient.pickDirectory !== "function") return;
          Promise.resolve(workspaceClient.pickDirectory()).then(function (picked) {
            if (typeof picked === "string" && picked.length > 0) {
              setPath(picked);
              mutate("add", { path: picked });
            }
          }).catch(function (error) {
            setState({ error: messageOf(error) });
          });
        }

        return h("div", {
          className: "dswa-backdrop",
          onClick: close
        }, h("div", {
          className: "dswa-dialog",
          role: "dialog",
          "aria-modal": "true",
          onClick: function (event) { event.stopPropagation(); }
        },
          h("div", { className: "dswa-head" },
            h("h2", { className: "dswa-title" }, t("title")),
            h("button", { type: "button", className: "dswa-x", "aria-label": t("close"), onClick: close }, "×")
          ),
          !view && busy ? h("div", { className: "dswa-empty" }, t("loading")) : null,
          view ? h("div", { className: "dswa-grid" },
            h("span", { className: "dswa-key" }, t("mode")),
            h("span", { className: "dswa-value" }, view.effectiveMode || view.defaultMode),
            h("span", { className: "dswa-key" }, t("workspace")),
            h("span", { className: "dswa-value" }, view.workspaceRoot)
          ) : null,
          view && view.deploymentRoots && view.deploymentRoots.length > 0
            ? h("div", { className: "dswa-section" },
                h("h3", null, t("deploymentRoots")),
                view.deploymentRoots.map(function (root) {
                  return h("div", { className: "dswa-row", key: root },
                    h("div", { className: "dswa-path" }, root),
                    h("span", { className: "dswa-tag" }, t("deploymentNote"))
                  );
                })
              )
            : null,
          view ? h("div", { className: "dswa-section" },
            h("h3", null, t("grants")),
            grants.length === 0 ? h("div", { className: "dswa-empty" }, t("noGrants")) : null,
            grants.map(function (grant) {
              return h("div", { className: "dswa-row", key: grant.path },
                h("div", null,
                  h("div", { className: "dswa-path" },
                    grant.path,
                    h("span", { className: "dswa-tag" }, grant.source === "fork" ? t("sourceFork") : t("sourceUser"))
                  ),
                  grant.coveredBy ? h("div", { className: "dswa-sub" }, t("coveredBy", { path: grant.coveredBy })) : null
                ),
                h("button", {
                  type: "button",
                  className: "dswa-btn dswa-btn-danger",
                  disabled: busy,
                  onClick: function () {
                    if (confirmPath !== grant.path) {
                      setConfirmPath(grant.path);
                      return;
                    }
                    setConfirmPath(null);
                    mutate("remove", { path: grant.path }).catch(function () {});
                  }
                }, confirmPath === grant.path ? t("confirmRevoke") : t("revoke"))
              );
            })
          ) : null,
          view ? h("div", { className: "dswa-section" },
            h("h3", null, t("pendingTitle")),
            pending.length === 0 ? h("div", { className: "dswa-empty" }, t("noPending")) : null,
            pending.map(function (request) {
              return h("div", { className: "dswa-row", key: request.requestId },
                h("div", null,
                  h("div", { className: "dswa-path" }, request.path),
                  h("div", { className: "dswa-sub" }, t("reason") + ": " + (request.reason || t("empty"))),
                  h("div", { className: "dswa-sub" }, t("requestedBy", { session: String(request.sessionId).slice(-8) })),
                  h("div", { className: "dswa-sub" }, t("allowNote"))
                ),
                h("div", { className: "dswa-actions" },
                  h("button", {
                    type: "button", className: "dswa-btn dswa-btn-primary", disabled: busy,
                    onClick: function () {
                      mutate("decide", { requestId: request.requestId, decision: "allow", expectedRevision: view.revision }).catch(function () {});
                    }
                  }, t("allow")),
                  h("button", {
                    type: "button", className: "dswa-btn", disabled: busy,
                    onClick: function () {
                      mutate("decide", { requestId: request.requestId, decision: "deny", expectedRevision: view.revision }).catch(function () {});
                    }
                  }, t("deny"))
                )
              );
            })
          ) : null,
          view ? h("div", { className: "dswa-section" },
            h("h3", null, t("addTitle")),
            h("div", { className: "dswa-actions" },
              h("input", {
                className: "dswa-input",
                value: path,
                placeholder: t("addPlaceholder"),
                onChange: function (event) { setPath(event.target.value); },
                onKeyDown: function (event) { if (event.key === "Enter" && path.trim()) mutate("add", { path: path.trim() }).catch(function () {}); }
              }),
              h("button", {
                type: "button", className: "dswa-btn dswa-btn-primary", disabled: busy || !path.trim(),
                onClick: function () { mutate("add", { path: path.trim() }).catch(function () {}); }
              }, t("add")),
              workspaceClient && typeof workspaceClient.pickDirectory === "function"
                ? h("button", { type: "button", className: "dswa-btn", disabled: busy, onClick: choose }, t("pick"))
                : null
            )
          ) : null,
          view ? h("div", { className: "dswa-section" },
            h("h3", null, t("forkTitle")),
            h("div", { className: "dswa-actions" },
              h("input", {
                className: "dswa-input",
                style: { maxWidth: "140px" },
                value: forkSeq,
                placeholder: t("forkSeq"),
                inputMode: "numeric",
                onChange: function (event) { setForkSeq(event.target.value); }
              }),
              h("button", {
                type: "button",
                className: "dswa-btn",
                disabled: busy,
                onClick: function () {
                  var parsed = forkSeq.trim() === "" ? undefined : Number(forkSeq.trim());
                  if (parsed !== undefined && (!Number.isSafeInteger(parsed) || parsed < 0)) {
                    setState({ error: t("forkSeq") + ": " + forkSeq });
                    return;
                  }
                  fork(parsed);
                }
              }, t("fork")),
              h("button", { type: "button", className: "dswa-btn", disabled: busy, onClick: refresh }, t("refresh"))
            ),
            h("div", { className: "dswa-note" }, t("forkNote")),
            h("div", { className: "dswa-note" }, t("oldProcessNote")),
            (view.forks || []).some(function (fork) { return fork.stage === "failed"; })
              ? h("div", { className: "dswa-error" }, t("forkPreviousFailed"))
              : null
          ) : null,
          recent && recent.length > 0 ? h("div", { className: "dswa-section" },
            h("h3", null, t("recent")),
            recent.map(function (request) {
              return h("div", { className: "dswa-row", key: request.requestId },
                h("div", { className: "dswa-path" }, request.path),
                h("span", { className: "dswa-tag" }, request.status)
              );
            })
          ) : null,
          noticeText ? h("div", { className: "dswa-note" }, noticeText) : null,
          errorText ? h("div", { className: "dswa-error" }, errorText) : null
        ));
      }

      ctx.slots.inject("conversation.input.left", function () {
        return ctx.slots.register({
          name: "conversation.input.left",
          id: "dsh-session-write-access",
          order: 40,
          label: function () { return t("panel"); },
          inject: function () { return {}; }
        }, PanelButton);
      });
      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register({
          name: "shell.overlay",
          id: "dsh-session-write-access",
          order: 60,
          inject: function () { return {}; }
        }, Overlay);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale", "uiWorkspace"];
    return module.exports;
  }
});
