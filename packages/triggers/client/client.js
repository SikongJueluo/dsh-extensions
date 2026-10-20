// Client half of dsh-triggers: the table editor for trigger rule groups.
//
// Two entries, one editor:
// - sidebar "触发器" → main panel: rule-group table (executor → parent /
//   parent → executor as two rows of one group), templates, run history and
//   delivery records;
// - a session-header status chip showing the runs touching that session with
//   quick pause/resume controls.
//
// All state lives in the host half (`/dsh-triggers` channel); every mutation
// is one small RPC and a full state reload, so the UI and the trigger_signal
// tool drive the same single source of truth. Plain JavaScript (no JSX),
// evaluated by the DSH client module loader. Touch-first: every control is a
// click target ≥ 44px, dropdowns open on tap, widths use min(px, vw).
window.__ModuleLoader__.load({
  id: "dsh-triggers",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    var RPC_BASE = "/dsh-triggers";
    var PANEL_ID = "dsh-triggers";
    var LOCALE_NS = "triggers";
    var POLL_MS = 15000;

    var rpcSeq = 0;
    function callRpc(endpoint, payload) {
      rpcSeq += 1;
      return fetch(RPC_BASE + "/" + endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "client-request",
          rpcId: "triggers-" + String(rpcSeq),
          method: endpoint,
          payload: payload || {}
        })
      }).then(function (r) { return r.json(); }).then(function (body) {
        var result = body && body.result;
        if (result && result.ok) return result.value;
        throw new Error(result && result.error ? result.error.message : "channel error");
      });
    }

    var zh = {
      panel: "触发器",
      title: "触发器",
      intro: "事件 + 模板 + 目标会话：执行—审核循环与单向通知共用同一套表格。所有自动交接由宿主推进，不依赖本页开着。",
      refresh: "刷新", refreshing: "加载中…", fetchFailed: "读取失败：{message}",
      groups: "规则组", newGroup: "新建规则组", emptyGroups: "还没有规则组。点「新建规则组」把两个会话绑成一对。",
      colSource: "来源 Session", colEvent: "触发事件", colTarget: "目标 Session", colTemplate: "Prompt 模板", colEnabled: "启用",
      eventDeliver: "本轮交付完成", eventRework: "审核要求返工",
      builtinBadge: "内置", roundBudget: "轮数预算",
      expand: "详情", collapse: "收起",
      startRun: "启动运行", running: "进行中", paused: "已暂停",
      runs: "运行记录", emptyRuns: "暂无运行记录。",
      runTask: "任务", runRound: "第 {round}/{max} 轮",
      statusActive: "进行中", statusPausedUser: "等待用户", statusPausedBudget: "轮次用尽待续",
      statusPausedError: "异常暂停", statusCompleted: "已完成", statusCancelled: "已取消",
      phaseAwaitingDelivery: "等待执行者", phaseAwaitingReview: "等待审核",
      pause: "暂停", resume: "恢复", cancel: "取消", extend: "续一轮",
      resumeNote: "随恢复带给对方的说明（可空）", resumeGo: "带说明恢复",
      endNote: "备注", pendingSignal: "本回合已有待提交信号",
      templates: "模板", newTemplate: "新建模板", emptyTemplates: "暂无模板。",
      templateName: "模板名称", templateBody: "模板正文", save: "保存", duplicate: "另存为副本", del: "删除",
      insertVar: "插入变量", builtinHint: "内置模板可编辑正文，不可删除；修改只影响之后启动的运行。",
      deliveries: "投递记录", emptyDeliveries: "暂无投递。",
      deliveryTo: "→ {to}", redeliver: "重投",
      statePending: "待发送", stateSent: "已送达", stateFailed: "失败",
      kindStart: "开工", kindReview: "送审", kindRework: "返工", kindNotice: "通知", kindResume: "恢复",
      pickSession: "选择会话…", searchSession: "搜索会话", pickTemplate: "选择模板…",
      sessionMissing: "（会话不在列表中）", loadSessions: "会话列表加载中…",
      headerIdle: "触发", headerMenu: "触发器运行",
      needBoth: "执行与审核会话都不能为空。", saved: "已保存", actionFailed: "操作失败：{message}",
      confirmDelete: "删除该规则组？（其未结束的运行会被取消）",
      confirmCancelRun: "取消该运行？",
      history: "历史", deliveryError: "错误", show: "{n} 条"
    };

    var en = {
      panel: "Triggers",
      title: "Triggers",
      intro: "Event + template + target session: the execute-review loop and one-way notices share this one table. All handoffs advance on the host; this page staying open is not required.",
      refresh: "Refresh", refreshing: "Loading…", fetchFailed: "Fetch failed: {message}",
      groups: "Rule groups", newGroup: "New group", emptyGroups: "No groups yet. Click \"New group\" to bind two sessions.",
      colSource: "Source Session", colEvent: "Trigger event", colTarget: "Target Session", colTemplate: "Prompt template", colEnabled: "On",
      eventDeliver: "round delivered", eventRework: "review requests rework",
      builtinBadge: "built-in", roundBudget: "Round budget",
      expand: "Details", collapse: "Collapse",
      startRun: "Start run", running: "running", paused: "paused",
      runs: "Runs", emptyRuns: "No runs yet.",
      runTask: "Task", runRound: "round {round}/{max}",
      statusActive: "active", statusPausedUser: "waiting for user", statusPausedBudget: "budget spent, resumable",
      statusPausedError: "paused on error", statusCompleted: "completed", statusCancelled: "cancelled",
      phaseAwaitingDelivery: "awaiting executor", phaseAwaitingReview: "awaiting review",
      pause: "Pause", resume: "Resume", cancel: "Cancel", extend: "+1 round",
      resumeNote: "Note to deliver with the resume (optional)", resumeGo: "Resume with note",
      endNote: "Note", pendingSignal: "a signal is pending this turn",
      templates: "Templates", newTemplate: "New template", emptyTemplates: "No templates.",
      templateName: "Template name", templateBody: "Template body", save: "Save", duplicate: "Save as copy", del: "Delete",
      insertVar: "Insert variable", builtinHint: "Built-ins can be edited but not deleted; edits affect future runs only.",
      deliveries: "Deliveries", emptyDeliveries: "No deliveries.",
      deliveryTo: "→ {to}", redeliver: "Resend",
      statePending: "pending", stateSent: "sent", stateFailed: "failed",
      kindStart: "start", kindReview: "review", kindRework: "rework", kindNotice: "notice", kindResume: "resume",
      pickSession: "Pick a session…", searchSession: "Search sessions", pickTemplate: "Pick a template…",
      sessionMissing: "(session not in list)", loadSessions: "loading sessions…",
      headerIdle: "Trigger", headerMenu: "Trigger runs",
      needBoth: "Executor and review sessions are both required.", saved: "Saved", actionFailed: "Action failed: {message}",
      confirmDelete: "Delete this group? (its unfinished runs are cancelled)",
      confirmCancelRun: "Cancel this run?",
      history: "History", deliveryError: "error", show: "{n} entries"
    };

    function template(text, vars) {
      return String(text).replace(/\{(\w+)\}/g, function (_, key) {
        return vars[key] === undefined ? "" : String(vars[key]);
      });
    }

    function fmtTime(ms) {
      if (typeof ms !== "number" || !isFinite(ms)) return "—";
      var d = new Date(ms);
      function p(n) { return String(n).padStart(2, "0"); }
      return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    // Enum → locale-key maps (status/phase/kind/state values carry hyphens).
    var STATUS_KEYS = {
      "active": "statusActive", "paused-user": "statusPausedUser", "paused-budget": "statusPausedBudget",
      "paused-error": "statusPausedError", "completed": "statusCompleted", "cancelled": "statusCancelled"
    };
    var PHASE_KEYS = { "awaiting-delivery": "phaseAwaitingDelivery", "awaiting-review": "phaseAwaitingReview" };
    var KIND_KEYS = { "start": "kindStart", "review": "kindReview", "rework": "kindRework", "notice": "kindNotice", "resume": "kindResume" };
    var DELIVERY_STATE_KEYS = { "pending": "statePending", "sent": "stateSent", "failed": "stateFailed" };

    function statusT(t, status) { return t(STATUS_KEYS[status] || status); }
    function phaseT(t, phase) { return t(PHASE_KEYS[phase] || phase); }
    function kindT(t, kind) { return t(KIND_KEYS[kind] || kind); }
    function deliveryStateT(t, state) { return t(DELIVERY_STATE_KEYS[state] || state); }

    function shortId(id) {
      return String(id).slice(0, 8);
    }

    // --- shared styles (theme tokens; light/dark both resolve) ---
    var S = {
      sectionTitle: { fontSize: 14, fontWeight: 600, margin: "18px 0 8px" },
      muted: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #9a9aa2)" },
      button: {
        minHeight: 44, minWidth: 44, padding: "8px 14px", borderRadius: 10,
        fontSize: 13, border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
        background: "var(--dsw-alias-fill-secondary, rgba(127,127,127,.15))",
        color: "var(--dsw-alias-label-primary, inherit)", cursor: "pointer"
      },
      buttonPrimary: {
        minHeight: 44, padding: "8px 16px", borderRadius: 10, fontSize: 13,
        border: "1px solid transparent", cursor: "pointer",
        background: "var(--dsw-alias-accent-major, #4c6ef5)", color: "#fff"
      },
      input: {
        minHeight: 44, padding: "8px 12px", borderRadius: 10, fontSize: 13,
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
        background: "var(--dsw-alias-fill-primary, transparent)",
        color: "var(--dsw-alias-label-primary, inherit)", width: "100%", boxSizing: "border-box"
      },
      chip: {
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "4px 10px", borderRadius: 999, fontSize: 12,
        background: "var(--dsw-alias-fill-secondary, rgba(127,127,127,.15))",
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))"
      },
      tableWrap: {
        overflowX: "auto", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))",
        borderRadius: 12, background: "var(--dsw-alias-bg-module-platform, transparent)"
      },
      table: { borderCollapse: "collapse", width: "100%", minWidth: 720, fontSize: 13 },
      th: {
        textAlign: "left", padding: "10px 12px", fontSize: 12, whiteSpace: "nowrap",
        color: "var(--dsw-alias-label-secondary, #b9b9c0)",
        borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))"
      },
      td: {
        padding: "8px 12px", verticalAlign: "middle", whiteSpace: "nowrap",
        borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.15))"
      },
      cellButton: {
        minHeight: 44, padding: "6px 12px", borderRadius: 10, cursor: "pointer",
        display: "inline-flex", alignItems: "center", gap: 8, maxWidth: 260,
        fontSize: 13, justifyContent: "flex-start",
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
        background: "var(--dsw-alias-fill-primary, transparent)",
        color: "var(--dsw-alias-label-primary, inherit)"
      },
      cellLabel: { overflow: "hidden", textOverflow: "ellipsis", maxWidth: 200 },
      caret: { fontSize: 10, opacity: 0.7 },
      popover: {
        position: "absolute", zIndex: 30, width: "min(320px, 90vw)", maxHeight: "50vh", overflowY: "auto",
        borderRadius: 12, padding: 6,
        background: "var(--dsw-specific-input-major, var(--dsw-alias-bg-module-platform, #232327))",
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
        boxShadow: "var(--dsw-elevation-panel, 0 12px 32px rgba(0,0,0,.35))"
      },
      popoverItem: {
        display: "block", width: "100%", textAlign: "left", cursor: "pointer",
        padding: "10px 12px", borderRadius: 8, minHeight: 44,
        background: "transparent", border: "none",
        color: "var(--dsw-alias-label-primary, inherit)", fontSize: 13
      },
      detailBox: {
        padding: "12px 16px", background: "var(--dsw-alias-fill-primary, rgba(127,127,127,.06))",
        borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.15))"
      },
      row: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }
    };

    // --- dropdown cell -----------------------------------------------------
    // A click-to-open picker. `options` is [{value, label, sub}] and `filter`
    // narrows them; the search box appears for lists longer than 8 entries.
    function PickerCell(props) {
      var openState = React.useState(false);
      var open = openState[0], setOpen = openState[1];
      var queryState = React.useState("");
      var query = queryState[0], setQuery = queryState[1];
      var ref = React.useRef(null);

      React.useEffect(function () {
        if (!open) return undefined;
        function onDown(event) {
          if (ref.current && !ref.current.contains(event.target)) setOpen(false);
        }
        document.addEventListener("pointerdown", onDown);
        return function () { document.removeEventListener("pointerdown", onDown); };
      }, [open]);

      var options = props.options || [];
      var filtered = query
        ? options.filter(function (option) {
            return (option.label + " " + (option.sub || "")).toLowerCase().indexOf(query.toLowerCase()) !== -1;
          })
        : options;
      var current = options.find(function (option) { return option.value === props.value; });

      return React.createElement("div", { ref: ref, style: { position: "relative", display: "inline-block" } },
        React.createElement("button", {
          type: "button", style: S.cellButton, onClick: function () { setOpen(!open); if (!open) setQuery(""); }
        },
          React.createElement("span", { style: S.cellLabel }, current ? current.label : props.placeholder),
          React.createElement("span", { style: S.caret }, "▾")
        ),
        open ? React.createElement("div", { style: S.popover },
          options.length > 8 ? React.createElement("input", {
            style: Object.assign({}, S.input, { minHeight: 40, marginBottom: 4, fontSize: 16 }),
            value: query, placeholder: props.searchPlaceholder || "",
            onChange: function (event) { setQuery(event.target.value); }
          }) : null,
          filtered.map(function (option) {
            return React.createElement("button", {
              key: option.value, type: "button", style: S.popoverItem,
              onClick: function () { setOpen(false); setQuery(""); props.onChange(option.value); }
            },
              React.createElement("div", null,
                React.createElement("span", null, option.label),
                option.sub ? React.createElement("span", { style: S.muted }, " · " + option.sub) : null
              )
            );
          }),
          filtered.length === 0 ? React.createElement("div", { style: Object.assign({}, S.muted, { padding: 10 }) }, props.emptyLabel || "—") : null
        ) : null
      );
    }

    // --- one rule group: two direction rows + expanded detail ---------------
    function BindingGroup(props) {
      var t = props.t;
      var data = props.data;
      var sessions = props.sessions;
      var binding = props.binding;
      var expandedState = React.useState(false);
      var expanded = expandedState[0], setExpanded = expandedState[1];
      var busyState = React.useState(false);
      var busy = busyState[0], setBusy = busyState[1];

      var templateOptions = data.templates.map(function (tpl) {
        return { value: tpl.id, label: tpl.name + (tpl.builtin ? " · " + t("builtinBadge") : "") };
      });

      var sessionLabel = function (id) {
        var session = sessions.find(function (row) { return row.id === id; });
        if (session) return session.title || shortId(id);
        return shortId(id) + " " + t("sessionMissing");
      };
      var sessionOptions = sessions.map(function (row) {
        return { value: row.id, label: row.title || shortId(row.id), sub: row.cwd ? row.cwd.split("/").slice(-1)[0] : undefined };
      });

      var save = function (patch) {
        var merged = Object.assign({
          id: binding.id, executor: binding.executor, parent: binding.parent,
          maxRounds: binding.maxRounds, enabled: binding.enabled, templates: binding.templates
        }, patch);
        if (props.draft) {
          // Draft mode: pickers only fill local state; commit once both sides exist.
          if (merged.executor && merged.parent && merged.executor !== merged.parent) {
            props.onAction({ endpoint: "binding.save", payload: merged });
            props.onDraftChange(null);
          } else {
            props.onDraftChange(merged);
          }
          return;
        }
        setBusy(true);
        props.onAction({ endpoint: "binding.save", payload: merged }).finally(function () { setBusy(false); });
      };

      var runs = props.draft ? [] : data.runs.filter(function (run) { return run.bindingId === binding.id; });
      var activeRun = runs.find(function (run) { return run.status === "active"; }) || runs[0];

      var direction = function (fromId, toId, eventLabel, templateId, onTemplate) {
        return React.createElement("tr", { key: eventLabel },
          React.createElement("td", { style: S.td },
            React.createElement(PickerCell, {
              value: fromId, options: sessionOptions, placeholder: t("pickSession"),
              searchPlaceholder: t("searchSession"),
              onChange: function (id) {
                var patch = fromId === binding.executor ? { executor: id } : { parent: id };
                save(patch);
              }
            })
          ),
          React.createElement("td", { style: S.td }, eventLabel, " →"),
          React.createElement("td", { style: S.td }, sessionLabel(toId)),
          React.createElement("td", { style: S.td },
            React.createElement(PickerCell, {
              value: templateId, options: templateOptions, placeholder: t("pickTemplate"),
              onChange: onTemplate
            })
          ),
          React.createElement("td", { style: S.td })
        );
      };

      return React.createElement(React.Fragment, null,
        direction(binding.executor, binding.parent, t("eventDeliver"), binding.templates.review, function (id) {
          save({ templates: Object.assign({}, binding.templates, { review: id }) });
        }),
        direction(binding.parent, binding.executor, t("eventRework"), binding.templates.rework, function (id) {
          save({ templates: Object.assign({}, binding.templates, { rework: id }) });
        }),
        React.createElement("tr", null,
          React.createElement("td", { style: S.td },
            props.draft ? React.createElement("span", { style: S.muted }, t("needBoth")) :
            React.createElement("label", { style: Object.assign({}, S.row, { cursor: "pointer" }) },
              React.createElement("input", {
                type: "checkbox", checked: binding.enabled, style: { width: 20, height: 20 },
                onChange: function (event) { save({ enabled: event.target.checked }); }
              }),
              React.createElement("span", { style: { fontSize: 12 } }, t("colEnabled"))
            )
          ),
          React.createElement("td", { style: S.td },
            activeRun ? React.createElement("span", { style: S.chip },
              t("runRound", { round: activeRun.round, max: activeRun.maxRounds }) + " · " + statusT(t, activeRun.status)
            ) : React.createElement("span", { style: S.muted }, t("roundBudget") + " " + binding.maxRounds)
          ),
          React.createElement("td", { style: S.td, colSpan: 2 }, binding.name),
          React.createElement("td", { style: S.td },
            React.createElement("div", { style: S.row },
              props.draft ? React.createElement("button", {
                type: "button", style: S.button, onClick: function () { props.onDraftChange(null); }
              }, t("collapse")) : React.createElement("button", {
                type: "button", style: S.button, disabled: busy,
                onClick: function () { setExpanded(!expanded); }
              }, expanded ? t("collapse") : t("expand")),
              props.draft ? null : React.createElement("button", {
                type: "button", style: S.button, disabled: busy,
                onClick: function () {
                  if (window.confirm(t("confirmDelete"))) {
                    setBusy(true);
                    props.onAction({ endpoint: "binding.delete", payload: { id: binding.id } })
                      .finally(function () { setBusy(false); });
                  }
                }
              }, t("del"))
            )
          )
        ),
        !props.draft && expanded ? React.createElement("tr", null,
          React.createElement("td", { style: S.detailBox, colSpan: 5 },
            React.createElement(RunControls, {
              t: t, runs: runs, deliveries: data.deliveries, onAction: props.onAction
            })
          )
        ) : null
      );
    }

    // --- run list + controls (shared by group detail and the runs section) --
    function RunControls(props) {
      var t = props.t;
      var noteState = React.useState("");
      var note = noteState[0], setNote = noteState[1];
      var busyState = React.useState(false);
      var busy = busyState[0], setBusy = busyState[1];

      var control = function (runId, action, extra) {
        setBusy(true);
        props.onAction({
          endpoint: "run.control",
          payload: Object.assign({ runId: runId, action: action }, extra || {})
        }).finally(function () { setBusy(false); });
      };

      if (!props.runs.length) return React.createElement("div", { style: S.muted }, t("emptyRuns"));

      return React.createElement("div", null, props.runs.map(function (run) {
        var deliveries = props.deliveries.filter(function (d) { return d.runId === run.id; }).slice(0, 8);
        var controls = [];
        if (run.status === "active") {
          controls.push(React.createElement("button", { key: "pause", type: "button", style: S.button, disabled: busy, onClick: function () { control(run.id, "pause"); } }, t("pause")));
        }
        if (run.status === "paused-user" || run.status === "paused-error") {
          controls.push(React.createElement("button", { key: "resume", type: "button", style: S.buttonPrimary, disabled: busy, onClick: function () { control(run.id, "resume"); } }, t("resume")));
        }
        if (run.status === "paused-budget") {
          controls.push(React.createElement("button", { key: "extend", type: "button", style: S.buttonPrimary, disabled: busy, onClick: function () { control(run.id, "extend"); } }, t("extend")));
        }
        if (run.status !== "completed" && run.status !== "cancelled") {
          controls.push(React.createElement("button", {
            key: "cancel", type: "button", style: S.button, disabled: busy,
            onClick: function () { if (window.confirm(t("confirmCancelRun"))) control(run.id, "cancel"); }
          }, t("cancel")));
        }
        var needsNote = run.status === "paused-user" || run.status === "paused-error";
        return React.createElement("div", {
          key: run.id, style: { padding: "8px 0", borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.12))" }
        },
          React.createElement("div", { style: S.row },
            React.createElement("span", { style: S.chip }, statusT(t, run.status)),
            React.createElement("span", { style: S.chip }, t("runRound", { round: run.round, max: run.maxRounds })),
            run.status === "active" ? React.createElement("span", { style: S.chip }, phaseT(t, run.phase)) : null,
            React.createElement("span", { style: S.muted }, fmtTime(run.startedAt))
          ),
          React.createElement("div", { style: S.row, marginTop: 6 }, controls),
          needsNote ? React.createElement("div", { style: Object.assign({}, S.row, { marginTop: 6 }) },
            React.createElement("input", {
              style: Object.assign({}, S.input, { flex: "1 1 220px", minHeight: 44, fontSize: 16 }),
              value: note, placeholder: t("resumeNote"),
              onChange: function (event) { setNote(event.target.value); }
            }),
            React.createElement("button", {
              type: "button", style: S.button, disabled: busy,
              onClick: function () { control(run.id, "resume", note.trim() ? { message: note.trim() } : undefined); setNote(""); }
            }, t("resumeGo"))
          ) : null,
          run.pendingSignal ? React.createElement("div", { style: Object.assign({}, S.muted, { marginTop: 4 }) }, t("pendingSignal")) : null,
          run.endNote ? React.createElement("div", { style: Object.assign({}, S.muted, { marginTop: 4 }) }, t("endNote") + "：" + run.endNote) : null,
          deliveries.length ? React.createElement("div", { style: { marginTop: 8 } },
            deliveries.map(function (d) {
              return React.createElement("div", { key: d.id, style: Object.assign({}, S.row, { marginTop: 4 }) },
                React.createElement("span", { style: S.chip }, kindT(t, d.kind)),
                React.createElement("span", { style: S.muted }, t("deliveryTo", { to: shortId(d.to) }) + " · " + fmtTime(d.createdAt) + " · " + deliveryStateT(t, d.state)),
                d.state === "failed" ? React.createElement("button", {
                  type: "button", style: S.button, disabled: busy,
                  onClick: function () { control(d.runId, "redeliver", { deliveryId: d.id }); }
                }, t("redeliver")) : null
              );
            })
          ) : null
        );
      }));
    }

    // --- template editor ----------------------------------------------------
    function TemplateEditor(props) {
      var t = props.t;
      var tpl = props.template;
      var nameState = React.useState(tpl ? tpl.name : "");
      var bodyState = React.useState(tpl ? tpl.body : "");
      var busyState = React.useState(false);
      var busy = busyState[0], setBusy = busyState[1];

      var variables = [
        { key: "summary", label: "{{summary}}" },
        { key: "task", label: "{{task}}" },
        { key: "round", label: "{{round}}" },
        { key: "maxRounds", label: "{{maxRounds}}" }
      ];

      var save = function (asCopy) {
        setBusy(true);
        props.onAction({
          endpoint: "template.save",
          payload: { id: asCopy ? undefined : (tpl ? tpl.id : undefined), name: nameState[0], body: bodyState[0] }
        }).finally(function () { setBusy(false); });
      };

      return React.createElement("div", { style: { padding: "10px 0 4px", width: "min(640px, 100%)" } },
        React.createElement("div", { style: S.row },
          React.createElement("input", {
            style: Object.assign({}, S.input, { flex: "1 1 240px", fontSize: 16 }), value: nameState[0],
            placeholder: t("templateName"),
            onChange: function (event) { nameState[1](event.target.value); }
          })
        ),
        React.createElement("div", { style: Object.assign({}, S.row, { marginTop: 6 }) },
          React.createElement("span", { style: S.muted }, t("insertVar") + "："),
          variables.map(function (v) {
            return React.createElement("button", {
              key: v.key, type: "button",
              style: Object.assign({}, S.button, { minHeight: 36, padding: "4px 10px", fontSize: 12 }),
              onClick: function () { bodyState[1](bodyState[0] + v.label); }
            }, v.label);
          })
        ),
        React.createElement("textarea", {
          style: Object.assign({}, S.input, {
            marginTop: 6, minHeight: 160, fontSize: 14, fontFamily: "var(--dsw-alias-font-mono, ui-monospace, monospace)",
            whiteSpace: "pre", resize: "vertical"
          }),
          value: bodyState[0], placeholder: t("templateBody"),
          onChange: function (event) { bodyState[1](event.target.value); }
        }),
        React.createElement("div", { style: Object.assign({}, S.row, { marginTop: 8 }) },
          React.createElement("button", { type: "button", style: S.buttonPrimary, disabled: busy, onClick: function () { save(false); } }, t("save")),
          React.createElement("button", { type: "button", style: S.button, disabled: busy, onClick: function () { save(true); } }, t("duplicate")),
          tpl && tpl.builtin ? null : React.createElement("button", {
            type: "button", style: S.button, disabled: busy,
            onClick: function () { props.onAction({ endpoint: "template.delete", payload: { id: tpl.id } }); }
          }, t("del"))
        ),
        tpl && tpl.builtin ? React.createElement("div", { style: Object.assign({}, S.muted, { marginTop: 6 }) }, t("builtinHint")) : null
      );
    }

    // --- the main panel ------------------------------------------------------
    function TriggersPage(props) {
      var t = props.t;
      var dataState = React.useState(null);
      var data = dataState[0], setData = dataState[1];
      var sessionsState = React.useState([]);
      var sessions = sessionsState[0], setSessions = sessionsState[1];
      var errState = React.useState(undefined);
      var error = errState[0], setError = errState[1];
      var busyState = React.useState(false);
      var busy = busyState[0], setBusy = busyState[1];
      var editingTemplateState = React.useState(undefined);
      var editingTemplate = editingTemplateState[0], setEditingTemplate = editingTemplateState[1];
      var draftState = React.useState(null);
      var draft = draftState[0], setDraft = draftState[1];

      var load = React.useCallback(function () {
        setBusy(true);
        setError(undefined);
        Promise.all([callRpc("state", {}), callRpc("sessions", {})])
          .then(function (results) {
            setData(results[0]);
            var items = results[1] && results[1].items ? results[1].items : [];
            setSessions(items.map(function (row) {
              return {
                id: row.id,
                title: row.title || undefined,
                cwd: row.cwd,
                updatedAt: row.updatedAt,
                running: row.running
              };
            }));
          })
          .catch(function (err) { setError(err && err.message ? err.message : String(err)); })
          .finally(function () { setBusy(false); });
      }, []);

      React.useEffect(load, [load]);

      var onAction = React.useCallback(function (request) {
        setError(undefined);
        return callRpc(request.endpoint, request.payload)
          .then(function () { return load(); })
          .catch(function (err) { setError(template(t("actionFailed"), { message: err && err.message ? err.message : String(err) })); });
      }, [load, t]);

      var body;
      if (error !== undefined && data === null) {
        body = React.createElement("div", { style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary, #9a9aa2)" } },
          template(t("fetchFailed"), { message: error }));
      } else if (data === null) {
        body = React.createElement("div", { style: S.muted }, t("refreshing"));
      } else {
        var templatesSection = React.createElement("div", null,
          React.createElement("div", { style: Object.assign({}, S.row, { justifyContent: "space-between" }) },
            React.createElement("h3", { style: Object.assign({}, S.sectionTitle, { margin: 0 }) }, t("templates")),
            React.createElement("button", {
              type: "button", style: S.button,
              onClick: function () { setEditingTemplate({ id: undefined }); }
            }, t("newTemplate"))
          ),
          React.createElement("div", { style: { marginTop: 6 } },
            data.templates.map(function (tpl) {
              var selected = editingTemplate && editingTemplate.id === tpl.id;
              return React.createElement("div", { key: tpl.id, style: S.row, marginTop: 4 },
                React.createElement("button", {
                  type: "button",
                  style: Object.assign({}, S.button, selected ? { background: "var(--dsw-alias-fill-secondary, rgba(127,127,127,.3))" } : {}),
                  onClick: function () { setEditingTemplate(selected ? undefined : tpl); }
                }, tpl.name + (tpl.builtin ? " · " + t("builtinBadge") : ""))
              );
            }),
            data.templates.length === 0 ? React.createElement("span", { style: S.muted }, t("emptyTemplates")) : null
          ),
          editingTemplate ? React.createElement(TemplateEditor, {
            t: t, template: editingTemplate.id ? editingTemplate : undefined, onAction: onAction
          }) : null
        );

        var groupsSection = React.createElement("div", null,
          React.createElement("div", { style: Object.assign({}, S.row, { justifyContent: "space-between" }) },
            React.createElement("h3", { style: Object.assign({}, S.sectionTitle, { margin: 0 }) }, t("groups")),
            React.createElement("div", { style: S.row },
              React.createElement("button", { type: "button", style: S.button, onClick: load }, busy ? t("refreshing") : t("refresh")),
              React.createElement("button", {
                type: "button", style: S.buttonPrimary,
                onClick: function () {
                  setDraft({
                    id: undefined, name: "", executor: "", parent: "",
                    maxRounds: 5, enabled: true,
                    templates: { start: "builtin-loop-start", review: "builtin-loop-review", rework: "builtin-loop-rework" }
                  });
                }
              }, t("newGroup"))
            )
          ),
          data.bindings.length === 0 && !draft ? React.createElement("div", { style: S.muted }, t("emptyGroups")) :
          React.createElement("div", { style: Object.assign({}, S.tableWrap, { marginTop: 8 }) },
            React.createElement("table", { style: S.table },
              React.createElement("thead", null, React.createElement("tr", null,
                React.createElement("th", { style: S.th }, t("colSource")),
                React.createElement("th", { style: S.th }, t("colEvent")),
                React.createElement("th", { style: S.th }, t("colTarget")),
                React.createElement("th", { style: S.th }, t("colTemplate")),
                React.createElement("th", { style: S.th }, t("colEnabled"))
              )),
              React.createElement("tbody", null,
                draft ? React.createElement(BindingGroup, {
                  key: "draft", t: t, binding: draft, data: data, sessions: sessions,
                  onAction: onAction, draft: true, onDraftChange: setDraft
                }) : null,
                data.bindings.map(function (binding) {
                  return React.createElement(BindingGroup, {
                    key: binding.id, t: t, binding: binding, data: data, sessions: sessions, onAction: onAction
                  });
                })
              )
            )
          )
        );

        var runsSection = React.createElement("div", null,
          React.createElement("h3", { style: S.sectionTitle }, t("runs")),
          data.runs.length === 0 ? React.createElement("div", { style: S.muted }, t("emptyRuns")) :
          React.createElement(RunControls, { t: t, runs: data.runs, deliveries: data.deliveries, onAction: onAction })
        );

        body = React.createElement("div", null, groupsSection, templatesSection, runsSection);
      }

      return React.createElement("div", { style: { padding: 16, maxWidth: 960, margin: "0 auto" } },
        React.createElement("h2", { style: { fontSize: 16, margin: "0 0 4px" } }, t("title")),
        React.createElement("div", { style: Object.assign({}, S.muted, { marginBottom: 4 }) }, t("intro")),
        error !== undefined && data !== null
          ? React.createElement("div", { style: { fontSize: 12, color: "#e5484d", marginBottom: 8 } }, error)
          : null,
        React.createElement("div", null, body)
      );
    }

    // --- session-header status chip -------------------------------------------
    // Shows the runs touching THIS session; opens a tap menu with the quick
    // controls. Renders nothing when the session has no runs.
    function TriggerHeaderAction(props) {
      var sessionId = props.sessionId;
      var t = props.t;
      var runsState = React.useState(null);
      var runs = runsState[0], setRuns = runsState[1];
      var openState = React.useState(false);
      var open = openState[0], setOpen = openState[1];
      var ref = React.useRef(null);

      var load = React.useCallback(function () {
        callRpc("state", {})
          .then(function (data) {
            return (data.runs || []).filter(function (run) {
              return run.executor === sessionId || run.parent === sessionId;
            });
          })
          .then(setRuns)
          .catch(function () { setRuns([]); });
      }, [sessionId]);

      React.useEffect(function () {
        load();
        var timer = setInterval(load, POLL_MS);
        return function () { clearInterval(timer); };
      }, [load]);

      React.useEffect(function () {
        if (!open) return undefined;
        function onDown(event) {
          if (ref.current && !ref.current.contains(event.target)) setOpen(false);
        }
        document.addEventListener("pointerdown", onDown);
        return function () { document.removeEventListener("pointerdown", onDown); };
      }, [open]);

      if (runs === null || runs.length === 0) return null;
      var run = runs.find(function (r) { return r.status === "active"; }) || runs[0];

      var control = function (action) {
        setOpen(false);
        callRpc("run.control", { runId: run.id, action: action }).then(load, load);
      };

      var stateText = run.status === "active" ? phaseT(t, run.phase) : statusT(t, run.status);

      return React.createElement("div", { ref: ref, style: { position: "relative", display: "inline-block" } },
        React.createElement("button", {
          type: "button", style: Object.assign({}, S.chip, {
            cursor: "pointer", minHeight: 44, background: "transparent"
          }),
          onClick: function () { setOpen(!open); }
        },
          React.createElement("span", null, t("headerIdle") + " · " + t("runRound", { round: run.round, max: run.maxRounds })),
          React.createElement("span", { style: S.muted }, stateText)
        ),
        open ? React.createElement("div", { style: Object.assign({}, S.popover, { right: 0, width: "min(280px, 80vw)" }) },
          React.createElement("div", { style: Object.assign({}, S.muted, { padding: "8px 12px" }) }, t("headerMenu")),
          run.status === "active" ? React.createElement("button", { type: "button", style: S.popoverItem, onClick: function () { control("pause"); } }, t("pause")) : null,
          run.status.indexOf("paused") === 0 && run.status !== "paused-budget"
            ? React.createElement("button", { type: "button", style: S.popoverItem, onClick: function () { control("resume"); } }, t("resume")) : null,
          run.status === "paused-budget"
            ? React.createElement("button", { type: "button", style: S.popoverItem, onClick: function () { control("extend"); } }, t("extend")) : null,
          run.status !== "completed" && run.status !== "cancelled"
            ? React.createElement("button", { type: "button", style: S.popoverItem, onClick: function () { control("cancel"); } }, t("cancel")) : null
        ) : null
      );
    }

    /** The sidebar entry's icon (a loop arrow). */
    function TriggersIcon() {
      return React.createElement("svg", {
        viewBox: "0 0 24 24", width: 18, height: 18, fill: "none",
        stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round"
      },
        React.createElement("path", { d: "M17 2l4 4-4 4" }),
        React.createElement("path", { d: "M3 11v-1a4 4 0 0 1 4-4h14" }),
        React.createElement("path", { d: "M7 22l-4-4 4-4" }),
        React.createElement("path", { d: "M21 13v1a4 4 0 0 1-4 4H3" })
      );
    }

    function apply(ctx) {
      ctx.effect(function () { return ctx.locale.register(LOCALE_NS, { zh: zh, en: en }); }, "dsh-triggers: locale");
      var t = ctx.locale.bind(LOCALE_NS);
      var boundPage = function () {
        return React.createElement(TriggersPage, { t: t });
      };
      ctx.slots.inject("main", function () {
        return ctx.slots.register({
          name: "main",
          key: PANEL_ID,
          locale: LOCALE_NS,
          inject: function () { return {}; }
        }, boundPage);
      });
      ctx.slots.inject("sidebar.panellist", function () {
        return ctx.slots.register({
          name: "sidebar.panellist",
          id: PANEL_ID,
          order: 30,
          locale: LOCALE_NS,
          label: function () { return t("panel"); }
        }, TriggersIcon);
      });
      ctx.slots.inject("conversation.session.header.actions", function () {
        return ctx.slots.register({
          name: "conversation.session.header.actions",
          id: "triggers-run",
          order: 30,
          locale: LOCALE_NS,
          inject: function () { return {}; }
        }, TriggerHeaderAction);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  }
});
