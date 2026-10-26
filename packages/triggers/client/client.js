// Client half of dsh-triggers: the current Session's trigger view.
//
// One Conversation tab (order 30) shows the execute/review loops THIS session
// takes part in — as executor or as reviewer — with the real run state, the
// reason it stopped, the controls the host accepts, and a read-only view of the
// binding. The host owns every transition; this half only reads
// `/dsh-triggers/state?sessionId=…` and posts run controls. There is no global
// template editor, no binding creation form, and no session-header control.
//
// Plain JavaScript (no JSX), evaluated by the DSH client module loader.
// Touch-first: actions are click targets ≥ 44px, fields use 16px text on
// mobile, widths shrink with the viewport, and hover is only an enhancement.
window.__ModuleLoader__.load({
  id: "dsh-triggers",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    var RPC_BASE = "/dsh-triggers";
    var LOCALE_NS = "triggers";
    var POLL_MS = 10000;
    var HISTORY_SHOWN = 6;
    var DELIVERY_SHOWN = 5;

    // A terse `React.createElement` alias: this module is loaded verbatim, so
    // no transform is available to turn JSX into calls.
    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2);
      return React.createElement.apply(null, [type, props].concat(children));
    }

    function callRpc(endpoint, payload) {
      var signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(30000)
        : undefined;
      return fetch(RPC_BASE + "/" + endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: signal,
        body: JSON.stringify({
          type: "client-request",
          rpcId: "triggers-" + String(Date.now()) + "-" + String(Math.random()).slice(2),
          method: endpoint,
          payload: payload || {}
        })
      }).then(function (response) { return response.json(); }).then(function (body) {
        var result = body && body.result;
        if (result && result.ok) return result.value;
        throw new Error(result && result.error ? result.error.message : "channel error");
      });
    }

    var zh = {
      viewLabel: "触发器",
      title: "触发器",
      refresh: "刷新", loading: "加载中…", loadFailed: "读取失败：{message}", retry: "重试", close: "关闭",
      noSession: "没有选中的会话。",
      activeSummary: "{n} 个运行进行中",
      emptyTitle: "当前会话暂无关联触发器。",
      emptyHint: "通过交接流程建立的循环会显示在这里。",
      roleExecutor: "你是执行者", roleReviewer: "你是审核者",
      peerExecutor: "执行者", peerReviewer: "审核者",
      unknownSession: "会话不可见", round: "第 {round}/{max} 轮",
      noRun: "尚未启动", noRunHint: "绑定已建立，等待第一次运行。",
      statusActiveDelivery: "等待交付", statusActiveReview: "等待审核",
      statusPausedUser: "等待用户", statusPausedBudget: "预算用尽",
      statusPausedError: "异常暂停", statusCompleted: "已完成", statusCancelled: "已取消",
      reasonAwaitingDeliverySelf: "等待你完成本回合并交付。",
      reasonAwaitingDeliveryPeer: "等待执行者完成本回合并交付。",
      reasonAwaitingReviewSelf: "等待你提交 rework / pass / needs_user 裁决。",
      reasonAwaitingReviewPeer: "等待审核者提交裁决。",
      reasonPausedUser: "等待用户处理后恢复。",
      reasonPausedUserSelf: "本会话提出了需要用户决定的事项，等待用户处理后恢复。",
      reasonPausedUserPeer: "对方提出了需要用户决定的事项，等待用户处理后恢复。",
      reasonPausedBudget: "轮次预算已用尽；续一轮后可以继续。",
      reasonPausedBudgetRework: "轮次预算已用尽；待返工的审核意见：{summary}",
      reasonPausedError: "运行因异常暂停；请查看投递错误，或恢复后重试。",
      reasonCompleted: "运行已完成。", reasonCancelled: "运行已取消。",
      pendingSignalNote: "本回合已有待提交信号；回合结束后按该信号推进。",
      endNote: "备注",
      pause: "暂停", resume: "恢复",
      resumeNotePlaceholder: "随恢复带给对方的说明（可空）",
      extend: "续一轮", cancel: "取消", confirmCancel: "取消该运行？", redeliver: "重投",
      actionFailed: "操作失败：{message}",
      details: "详情", otherRuns: "其他运行",
      historyTitle: "历史", historyTruncated: "最近 {shown} 条，共 {total} 条",
      deliveriesTitle: "投递", attentionDeliveries: "需要处理", sentDeliveries: "已送达",
      deliveriesTruncated: "最近 {shown} 条，共 {total} 条",
      deliveryTo: "→ {to}", deliveryError: "错误：{message}",
      configTitle: "配置",
      configExecutor: "执行会话", configReviewer: "审核会话", configRounds: "轮次预算",
      configAuto: "自动送审", configTemplates: "模板", configEnabled: "绑定状态",
      configEnabledOn: "启用", configDisabled: "已停用",
      configHint: "配置来自交接流程，本页只读。",
      autoOn: "开", autoOff: "关",
      missingBindingNote: "绑定配置当前不可见；以下运行保留启动时的会话快照。",
      snapshotNote: "当前绑定已改配对；本次运行仍按启动时的会话快照显示。",
      untitledRun: "未命名运行",
      tplStart: "开工", tplReview: "送审", tplRework: "返工",
      expand: "展开详情", collapse: "收起详情",
      statePending: "待发送", stateSent: "已送达", stateFailed: "失败",
      kindStart: "开工", kindReview: "送审", kindRework: "返工", kindNotice: "通知", kindResume: "恢复", kindNudge: "提醒",
      histStarted: "启动", histSignal: "信号", histAdvance: "推进", histPause: "暂停",
      histResume: "恢复", histEnd: "结束", histNote: "备注", histDelivery: "投递", histNudge: "提醒"
    };

    var en = {
      viewLabel: "Triggers",
      title: "Triggers",
      refresh: "Refresh", loading: "Loading…", loadFailed: "Could not load: {message}", retry: "Retry", close: "Dismiss",
      noSession: "No session selected.",
      activeSummary: "{n} runs active",
      emptyTitle: "No triggers are associated with this session.",
      emptyHint: "Loops created by a handoff appear here.",
      roleExecutor: "You are the executor", roleReviewer: "You are the reviewer",
      peerExecutor: "Executor", peerReviewer: "Reviewer",
      unknownSession: "session unavailable", round: "round {round}/{max}",
      noRun: "Not started", noRunHint: "The binding exists; waiting for its first run.",
      statusActiveDelivery: "Awaiting delivery", statusActiveReview: "Awaiting review",
      statusPausedUser: "Waiting for user", statusPausedBudget: "Round budget spent",
      statusPausedError: "Paused on error", statusCompleted: "Completed", statusCancelled: "Cancelled",
      reasonAwaitingDeliverySelf: "Waiting for you to finish this round and deliver.",
      reasonAwaitingDeliveryPeer: "Waiting for the executor to finish this round and deliver.",
      reasonAwaitingReviewSelf: "Waiting for your rework / pass / needs_user verdict.",
      reasonAwaitingReviewPeer: "Waiting for the reviewer's verdict.",
      reasonPausedUser: "Waiting for the user to resolve it, then resume.",
      reasonPausedUserSelf: "This session raised a decision for the user; the loop resumes afterwards.",
      reasonPausedUserPeer: "The other side raised a decision for the user; the loop resumes afterwards.",
      reasonPausedBudget: "The round budget is spent; extend it to continue.",
      reasonPausedBudgetRework: "The round budget is spent; pending rework: {summary}",
      reasonPausedError: "The run paused on an error; check delivery errors or resume to retry.",
      reasonCompleted: "The run completed.", reasonCancelled: "The run was cancelled.",
      pendingSignalNote: "A signal is already pending this turn; the run advances when the turn ends.",
      endNote: "Note",
      pause: "Pause", resume: "Resume",
      resumeNotePlaceholder: "Optional note to deliver with the resume",
      extend: "+1 round", cancel: "Cancel", confirmCancel: "Cancel this run?", redeliver: "Resend",
      actionFailed: "Action failed: {message}",
      details: "Details", otherRuns: "Other runs",
      historyTitle: "History", historyTruncated: "latest {shown} of {total}",
      deliveriesTitle: "Deliveries", attentionDeliveries: "Needs attention", sentDeliveries: "Sent",
      deliveriesTruncated: "latest {shown} of {total}",
      deliveryTo: "→ {to}", deliveryError: "Error: {message}",
      configTitle: "Configuration",
      configExecutor: "Executor", configReviewer: "Reviewer", configRounds: "Round budget",
      configAuto: "Auto-deliver", configTemplates: "Templates", configEnabled: "Binding",
      configEnabledOn: "enabled", configDisabled: "disabled",
      configHint: "Set by the handoff; read-only here.",
      autoOn: "on", autoOff: "off",
      missingBindingNote: "The binding configuration is not visible here; runs below keep their start-time session snapshot.",
      snapshotNote: "The binding pair changed; this run still follows its start-time session snapshot.",
      untitledRun: "Untitled run",
      tplStart: "Start", tplReview: "Review", tplRework: "Rework",
      expand: "Expand details", collapse: "Collapse details",
      statePending: "pending", stateSent: "sent", stateFailed: "failed",
      kindStart: "start", kindReview: "review", kindRework: "rework", kindNotice: "notice", kindResume: "resume", kindNudge: "nudge",
      histStarted: "started", histSignal: "signal", histAdvance: "advanced", histPause: "paused",
      histResume: "resumed", histEnd: "ended", histNote: "note", histDelivery: "delivery", histNudge: "nudge"
    };

    function template(text, vars) {
      return String(text).replace(/\{(\w+)\}/g, function (_, key) {
        return vars[key] === undefined ? "" : String(vars[key]);
      });
    }

    function messageOf(error) {
      return error && error.message ? error.message : String(error);
    }

    function fmtTime(ms) {
      if (typeof ms !== "number" || !isFinite(ms)) return "—";
      var date = new Date(ms);
      function pad(value) { return String(value).padStart(2, "0"); }
      return pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
    }

    // Host session ids share long common prefixes (`session-<uuid>` or plain
    // `session-<n>`); a fixed head slice collapses them. Strip the prefix and
    // abbreviate the tail instead. Titles are the primary label and this is
    // the fallback for a session missing from the client catalog.
    function shortId(id) {
      var raw = String(id).replace(/^session-/, "");
      if (raw.length <= 10) return raw;
      return raw.slice(0, 4) + "…" + raw.slice(-4);
    }

    function safeId(value) {
      return String(value).replace(/[^A-Za-z0-9_-]/g, "-");
    }

    function sessionLabel(t, sessionsById, id) {
      if (typeof id !== "string" || id.length === 0) return t("unknownSession");
      var row = sessionsById && sessionsById[id];
      if (row) {
        var title = row.displayTitle || row.title;
        if (typeof title === "string" && title.length > 0) return title;
        return shortId(id);
      }
      // Before the Session catalog arrives, absence is not evidence of a lost
      // session; show the distinguishable short id without the warning.
      var catalogKnown = sessionsById !== undefined && sessionsById !== null &&
        Object.keys(sessionsById).length > 0;
      return shortId(id) + (catalogKnown ? " · " + t("unknownSession") : "");
    }

    function roleOf(record, sessionId) {
      if (!record) return undefined;
      if (record.executor === sessionId) return "executor";
      if (record.parent === sessionId) return "parent";
      return undefined;
    }

    function peerOf(record, sessionId) {
      if (!record) return undefined;
      if (record.executor === sessionId) return record.parent;
      if (record.parent === sessionId) return record.executor;
      return undefined;
    }

    var STATUS_KEYS = {
      "paused-user": "statusPausedUser", "paused-budget": "statusPausedBudget",
      "paused-error": "statusPausedError", "completed": "statusCompleted", "cancelled": "statusCancelled"
    };
    var HISTORY_KEYS = {
      "started": "histStarted", "signal": "histSignal", "advance": "histAdvance",
      "pause": "histPause", "resume": "histResume", "end": "histEnd",
      "note": "histNote", "delivery": "histDelivery", "nudge": "histNudge"
    };
    var KIND_KEYS = {
      "start": "kindStart", "review": "kindReview", "rework": "kindRework",
      "notice": "kindNotice", "resume": "kindResume", "nudge": "kindNudge"
    };
    var DELIVERY_STATE_KEYS = { "pending": "statePending", "sent": "stateSent", "failed": "stateFailed" };

    function runStateText(t, run) {
      if (!run) return t("noRun");
      if (run.status === "active") {
        return run.phase === "awaiting-review" ? t("statusActiveReview") : t("statusActiveDelivery");
      }
      return t(STATUS_KEYS[run.status] || run.status);
    }

    function statusTone(status) {
      if (status === "active") return "success";
      if (status === "paused-user" || status === "paused-budget") return "warn";
      if (status === "paused-error") return "error";
      return "idle";
    }

    function groupTitle(t, group) {
      var run = group.current;
      if (run && typeof run.task === "string" && run.task.trim().length > 0) return run.task;
      var binding = group.binding;
      if (binding && typeof binding.name === "string" && binding.name.trim().length > 0) return binding.name;
      return t("untitledRun");
    }

    function pickCurrentRun(runs) {
      var rank = { "paused-error": 0, "paused-user": 1, "paused-budget": 2, "active": 3, "completed": 4, "cancelled": 5 };
      return runs.slice().sort(function (left, right) {
        var leftRank = rank[left.status] === undefined ? 9 : rank[left.status];
        var rightRank = rank[right.status] === undefined ? 9 : rank[right.status];
        return leftRank - rightRank || right.startedAt - left.startedAt;
      })[0];
    }

    function groupRank(group) {
      if (!group.current) return 4;
      var rank = { "paused-error": 0, "paused-user": 1, "paused-budget": 2, "active": 3, "completed": 5, "cancelled": 6 };
      return rank[group.current.status] === undefined ? 7 : rank[group.current.status];
    }

    function groupActivity(group) {
      var latest = 0;
      for (var index = 0; index < group.runs.length; index++) {
        var run = group.runs[index];
        latest = Math.max(latest, run.startedAt || 0, run.endedAt || 0);
      }
      return latest;
    }

    /** Defensive client-side scope: the host already filters before limiting,
     * but a stale/replayed response must never leak another session's rows. */
    function scopeSnapshot(data, sessionId) {
      var bindings = (data.bindings || []).filter(function (binding) {
        return binding.executor === sessionId || binding.parent === sessionId;
      });
      var runs = (data.runs || []).filter(function (run) {
        return run.executor === sessionId || run.parent === sessionId;
      });
      var runIds = Object.create(null);
      runs.forEach(function (run) { runIds[run.id] = true; });
      var deliveries = (data.deliveries || []).filter(function (delivery) { return runIds[delivery.runId]; });
      return {
        templates: data.templates || [],
        bindings: bindings,
        runs: runs,
        deliveries: deliveries
      };
    }

    function buildGroups(data, sessionId) {
      var groups = [];
      var byBinding = Object.create(null);
      data.bindings.forEach(function (binding) {
        var group = { id: binding.id, binding: binding, runs: [] };
        byBinding[binding.id] = group;
        groups.push(group);
      });
      data.runs.forEach(function (run) {
        var group = byBinding[run.bindingId];
        if (group === undefined) {
          group = { id: run.bindingId || ("run-" + run.id), binding: undefined, runs: [] };
          byBinding[group.id] = group;
          groups.push(group);
        }
        group.runs.push(run);
      });
      groups.forEach(function (group) {
        group.runs.sort(function (left, right) { return right.startedAt - left.startedAt; });
        group.current = pickCurrentRun(group.runs);
        var record = group.current || group.binding;
        group.role = roleOf(record, sessionId);
        group.peer = peerOf(record, sessionId);
      });
      groups.sort(function (left, right) {
        return groupRank(left) - groupRank(right) || groupActivity(right) - groupActivity(left);
      });
      return groups;
    }

    function runReason(t, run, role) {
      if (run.status === "active") {
        if (run.phase === "awaiting-review") {
          return role === "parent" ? t("reasonAwaitingReviewSelf") : t("reasonAwaitingReviewPeer");
        }
        return role === "executor" ? t("reasonAwaitingDeliverySelf") : t("reasonAwaitingDeliveryPeer");
      }
      if (run.status === "paused-user") {
        if (run.pausedBy === undefined) return t("reasonPausedUser");
        return run.pausedBy === role ? t("reasonPausedUserSelf") : t("reasonPausedUserPeer");
      }
      if (run.status === "paused-budget") {
        return run.pendingRework
          ? t("reasonPausedBudgetRework", { summary: run.pendingRework.summary })
          : t("reasonPausedBudget");
      }
      if (run.status === "paused-error") {
        var detail = lastStopDetail(run);
        return detail === undefined ? t("reasonPausedError") : t("reasonPausedError") + " " + detail;
      }
      if (run.status === "completed") return t("reasonCompleted");
      if (run.status === "cancelled") return t("reasonCancelled");
      return "";
    }

    function lastStopDetail(run) {
      var history = run.history || [];
      for (var index = history.length - 1; index >= 0; index--) {
        var entry = history[index];
        if ((entry.kind === "pause" || entry.kind === "end") && typeof entry.detail === "string" && entry.detail.length > 0) {
          return entry.detail;
        }
      }
      return undefined;
    }

    /** Redelivery is offered only when the server would accept it: the run is
     * active (retry the send) or parked by that delivery's failure (resume and
     * resend), AND the delivery belongs to the round and side the run is
     * currently waiting on. Terminal runs, user/budget pauses, and stale
     * rounds are all refused server-side. */
    function canRedeliver(run, delivery) {
      if (!delivery || delivery.state !== "failed") return false;
      if (run.status !== "active" && run.status !== "paused-error") return false;
      if (delivery.round !== run.round) return false;
      if (delivery.kind === "review") return run.phase === "awaiting-review";
      if (delivery.kind === "start" || delivery.kind === "rework") return run.phase === "awaiting-delivery";
      return true;
    }

    function Chevron(props) {
      return h("svg", {
        viewBox: "0 0 24 24", width: 16, height: 16, fill: "none",
        stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true", className: props.className
      }, h("path", { d: "m6 9 6 6 6-6" }));
    }

    function RefreshIcon() {
      return h("svg", {
        viewBox: "0 0 24 24", width: 16, height: 16, fill: "none",
        stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true"
      },
        h("path", { d: "M20 11a8 8 0 1 0-2.3 5.7" }),
        h("path", { d: "M20 4v7h-7" })
      );
    }

    function fact(label, value, wide) {
      return h("div", { className: "dsh-triggers-fact" + (wide ? " dsh-triggers-fact-wide" : "") },
        h("div", { className: "dsh-triggers-fact-label" }, label),
        h("div", { className: "dsh-triggers-fact-value" }, value)
      );
    }

    function ConfigFacts(props) {
      var t = props.t;
      var binding = props.binding;
      var sessionsById = props.sessionsById;
      var templatesById = Object.create(null);
      (props.templates || []).forEach(function (templateRecord) { templatesById[templateRecord.id] = templateRecord; });
      function templateName(id) {
        var record = templatesById[id];
        if (record && typeof record.name === "string" && record.name.length > 0) return record.name;
        return id || "—";
      }
      var refs = binding.templates || {};
      var templates = t("tplStart") + " " + templateName(refs.start) + " · " +
        t("tplReview") + " " + templateName(refs.review) + " · " +
        t("tplRework") + " " + templateName(refs.rework);
      return h("section", { className: "dsh-triggers-config", "aria-label": t("configTitle") },
        h("div", { className: "dsh-triggers-facts" },
          fact(t("configExecutor"), sessionLabel(t, sessionsById, binding.executor)),
          fact(t("configReviewer"), sessionLabel(t, sessionsById, binding.parent)),
          fact(t("configRounds"), String(binding.maxRounds)),
          fact(t("configAuto"), binding.autoDeliver ? t("autoOn") : t("autoOff")),
          fact(t("configEnabled"), binding.enabled === false ? t("configDisabled") : t("configEnabledOn")),
          fact(t("configTemplates"), templates, true)
        ),
        h("p", { className: "dsh-triggers-hint" }, t("configHint"))
      );
    }

    function HistoryList(props) {
      var t = props.t;
      var history = props.run.history || [];
      if (history.length === 0) return null;
      var shown = history.slice(-HISTORY_SHOWN);
      return h("div", { className: "dsh-triggers-subsection" },
        h("div", { className: "dsh-triggers-sublabel" },
          t("historyTitle") + (history.length > shown.length ? " · " + t("historyTruncated", { shown: shown.length, total: history.length }) : "")
        ),
        shown.map(function (entry, index) {
          return h("div", { key: index, className: "dsh-triggers-history-row" },
            h("span", { className: "dsh-triggers-time" }, fmtTime(entry.at)),
            h("span", { className: "dsh-triggers-history-text" },
              t(HISTORY_KEYS[entry.kind] || entry.kind) + (entry.detail ? " · " + entry.detail : "")
            )
          );
        })
      );
    }

    function DeliveryList(props) {
      var t = props.t;
      var run = props.run;
      var deliveries = props.deliveries || [];
      var busyState = React.useState(null);
      var busy = busyState[0], setBusy = busyState[1];
      var sessionsById = props.sessionsById;

      if (deliveries.length === 0) return null;
      var limit = typeof props.limit === "number" ? props.limit : DELIVERY_SHOWN;
      var shown = deliveries.slice(0, limit);

      function resend(delivery) {
        if (busy !== null) return;
        setBusy(delivery.id);
        Promise.resolve(props.onAction("run.control", {
          runId: delivery.runId, action: "redeliver", deliveryId: delivery.id
        })).finally(function () { setBusy(null); });
      }

      return h("div", { className: "dsh-triggers-subsection" },
        h("div", { className: "dsh-triggers-sublabel" }, props.title || t("deliveriesTitle")),
        shown.map(function (delivery) {
          return h("div", { key: delivery.id, className: "dsh-triggers-delivery" },
            h("span", { className: "dsh-triggers-chip" }, t(KIND_KEYS[delivery.kind] || delivery.kind)),
            h("span", { className: "dsh-triggers-muted" },
              t("deliveryTo", { to: sessionLabel(t, sessionsById, delivery.to) }) + " · " + fmtTime(delivery.createdAt)
            ),
            h("span", { className: "dsh-triggers-state", "data-tone": delivery.state === "failed" ? "error" : delivery.state === "sent" ? "success" : "warn" },
              t(DELIVERY_STATE_KEYS[delivery.state] || delivery.state)
            ),
            canRedeliver(run, delivery) ? h("button", {
              type: "button", className: "dsh-triggers-button",
              disabled: busy !== null,
              onClick: function () { resend(delivery); }
            }, t("redeliver")) : null,
            delivery.error ? h("span", { className: "dsh-triggers-error-text" },
              t("deliveryError", { message: delivery.error })
            ) : null
          );
        }),
        deliveries.length > shown.length ? h("p", { className: "dsh-triggers-hint" },
          t("deliveriesTruncated", { shown: shown.length, total: deliveries.length })
        ) : null
      );
    }

    function RunActions(props) {
      var t = props.t;
      var run = props.run;
      var busyState = React.useState(false);
      var busy = busyState[0], setBusy = busyState[1];
      var noteState = React.useState("");
      var note = noteState[0], setNote = noteState[1];

      function control(action, extra) {
        if (busy) return;
        setBusy(true);
        Promise.resolve(props.onAction("run.control", Object.assign({ runId: run.id, action: action }, extra || {})))
          .then(function (ok) { if (ok) setNote(""); })
          .finally(function () { setBusy(false); });
      }

      var buttons = [];
      if (run.status === "active") {
        buttons.push(h("button", {
          key: "pause", type: "button", className: "dsh-triggers-button", disabled: busy,
          onClick: function () { control("pause"); }
        }, t("pause")));
      }
      if (run.status === "paused-budget") {
        buttons.push(h("button", {
          key: "extend", type: "button", className: "dsh-triggers-button", "data-variant": "primary", disabled: busy,
          onClick: function () { control("extend"); }
        }, t("extend")));
      }
      if (run.status !== "completed" && run.status !== "cancelled") {
        buttons.push(h("button", {
          key: "cancel", type: "button", className: "dsh-triggers-button", "data-variant": "quiet", disabled: busy,
          onClick: function () {
            if (typeof window !== "undefined" && window.confirm(t("confirmCancel"))) control("cancel");
          }
        }, t("cancel")));
      }

      // Resume keeps one primary action: an optional note rides along when the
      // input has text, so paused runs do not grow a second, near-duplicate
      // button beside the plain one.
      var needsNote = run.status === "paused-user" || run.status === "paused-error";
      if (!needsNote && buttons.length === 0) return null;
      return h("div", null,
        needsNote ? h("div", { className: "dsh-triggers-note-row" },
          h("input", {
            className: "dsh-triggers-input",
            value: note,
            placeholder: t("resumeNotePlaceholder"),
            "aria-label": t("resumeNotePlaceholder"),
            onChange: function (event) { setNote(event.target.value); }
          }),
          h("button", {
            type: "button", className: "dsh-triggers-button", "data-variant": "primary", disabled: busy,
            onClick: function () {
              control("resume", note.trim().length > 0 ? { message: note.trim() } : undefined);
            }
          }, t("resume"))
        ) : null,
        buttons.length > 0 ? h("div", { className: "dsh-triggers-actions" }, buttons) : null
      );
    }

    /** One low-frequency drawer. Its contents answer "what happened" or "how
     * is it configured", never "why is it stopped" or "what can I do", so it
     * starts closed while keeping a 44px tap target. */
    function Disclosure(props) {
      var openState = React.useState(props.defaultOpen === true);
      var open = openState[0], setOpen = openState[1];
      return h("div", { className: "dsh-triggers-disclosure" },
        h("button", {
          type: "button", className: "dsh-triggers-disclosure-toggle",
          "aria-expanded": open,
          onClick: function () { setOpen(!open); }
        },
          h("span", { className: "dsh-triggers-disclosure-label" }, props.label),
          h(Chevron, { className: "dsh-triggers-chevron", "data-open": open ? "true" : "false" })
        ),
        open ? h("div", { className: "dsh-triggers-disclosure-body" }, props.children) : null
      );
    }

    function RunDetails(props) {
      var t = props.t;
      var run = props.run;
      var deliveries = props.deliveries || [];
      var sent = deliveries.filter(function (delivery) { return delivery.state === "sent"; });
      var history = run.history || [];
      if (history.length === 0 && sent.length === 0 && props.binding === undefined) return null;
      var label = history.length === 0 && sent.length === 0 ? t("configTitle") : t("details");
      return h(Disclosure, { label: label },
        h(HistoryList, { t: t, run: run }),
        sent.length > 0 ? h(DeliveryList, {
          t: t, title: t("sentDeliveries"), run: run, sessionsById: props.sessionsById,
          deliveries: sent, onAction: props.onAction
        }) : null,
        props.binding !== undefined ? h(ConfigFacts, {
          t: t, binding: props.binding, sessionsById: props.sessionsById, templates: props.templates
        }) : null
      );
    }

    /** Body of one run, without a second title/status/round header. The row
     * summary already carries those for the current run; other runs supply
     * their own compact header. */
    function RunBody(props) {
      var t = props.t;
      var run = props.run;
      var role = roleOf(run, props.sessionId);
      var deliveries = (props.deliveries || []).filter(function (delivery) { return delivery.runId === run.id; });
      var attention = deliveries.filter(function (delivery) { return delivery.state !== "sent"; });
      return h("div", { className: "dsh-triggers-run-body" },
        h("p", { className: "dsh-triggers-reason" }, runReason(t, run, role)),
        run.pendingSignal ? h("p", { className: "dsh-triggers-hint" }, t("pendingSignalNote")) : null,
        run.endNote ? h("p", { className: "dsh-triggers-hint" }, t("endNote") + "：" + run.endNote) : null,
        attention.length > 0 ? h(DeliveryList, {
          t: t, title: t("attentionDeliveries"), run: run, sessionsById: props.sessionsById,
          deliveries: attention, onAction: props.onAction, limit: attention.length
        }) : null,
        h(RunActions, { t: t, run: run, onAction: props.onAction }),
        h(RunDetails, {
          t: t, run: run, sessionsById: props.sessionsById, deliveries: deliveries,
          onAction: props.onAction, templates: props.templates,
          binding: props.showConfig === true ? props.binding : undefined
        })
      );
    }

    /** A non-current run: compact header, closed until asked for. */
    function RunEntry(props) {
      var t = props.t;
      var run = props.run;
      var openState = React.useState(false);
      var open = openState[0], setOpen = openState[1];
      var tone = statusTone(run.status);
      var title = typeof run.task === "string" && run.task.trim().length > 0 ? run.task : t("untitledRun");
      var detailId = "dsh-triggers-run-" + safeId(run.id);

      return h("div", { className: "dsh-triggers-run" },
        h("button", {
          type: "button", className: "dsh-triggers-run-head",
          "aria-expanded": open, "aria-controls": detailId,
          onClick: function () { setOpen(!open); }
        },
          h("span", { className: "dsh-triggers-chip", "data-tone": tone }, runStateText(t, run)),
          h("span", { className: "dsh-triggers-run-title" }, title),
          h("span", { className: "dsh-triggers-run-meta" },
            t("round", { round: run.round, max: run.maxRounds }) + " · " + fmtTime(run.startedAt)
          ),
          h(Chevron, { className: "dsh-triggers-chevron", "data-open": open ? "true" : "false" })
        ),
        open ? h("div", { id: detailId },
          h(RunBody, {
            t: t, run: run, sessionId: props.sessionId, sessionsById: props.sessionsById,
            deliveries: props.deliveries, onAction: props.onAction, binding: undefined, showConfig: false
          })
        ) : null
      );
    }

    function TriggerRow(props) {
      var t = props.t;
      var group = props.group;
      var binding = group.binding;
      var current = group.current;
      var sessionsById = props.sessionsById;
      var expandedState = React.useState(false);
      var expanded = expandedState[0], setExpanded = expandedState[1];
      var tone = current ? statusTone(current.status) : "idle";
      var stateText = runStateText(t, current);
      var title = groupTitle(t, group);
      var peerLabel = group.role === "parent" ? t("peerExecutor") : t("peerReviewer");
      var peer = sessionLabel(t, sessionsById, group.peer);
      var detailId = "dsh-triggers-detail-" + safeId(group.id);
      var others = current === undefined ? [] : group.runs.filter(function (run) { return run.id !== current.id; });
      var bindingPairChanged = binding !== undefined && current !== undefined &&
        (binding.executor !== current.executor || binding.parent !== current.parent);

      function toggle() { setExpanded(!expanded); }

      return h("article", { className: "dsh-triggers-item" },
        h("div", { className: "dsh-triggers-row" },
          h("button", {
            type: "button", className: "dsh-triggers-row-main",
            "aria-expanded": expanded, "aria-controls": detailId,
            onClick: toggle
          },
            h("span", { className: "dsh-triggers-dot", "data-tone": tone, "aria-hidden": "true" }),
            h("span", { className: "dsh-triggers-row-text" },
              h("span", { className: "dsh-triggers-row-title", title: title }, title),
              h("span", { className: "dsh-triggers-row-meta" },
                group.role ? h("span", { className: "dsh-triggers-role" },
                  group.role === "executor" ? t("roleExecutor") : t("roleReviewer")
                ) : null,
                group.role ? h("span", { className: "dsh-triggers-sep" }, "·") : null,
                group.role ? h("span", null, peerLabel + " " + peer) : h("span", null, peer),
                current ? h("span", { className: "dsh-triggers-sep" }, "·") : null,
                current ? h("span", null, t("round", { round: current.round, max: current.maxRounds })) : null
              )
            )
          ),
          h("span", { className: "dsh-triggers-side" },
            h("span", { className: "dsh-triggers-state", "data-tone": tone }, stateText),
            h("button", {
              type: "button", className: "dsh-triggers-iconbtn",
              "aria-expanded": expanded, "aria-controls": detailId,
              "aria-label": expanded ? t("collapse") : t("expand"),
              onClick: toggle
            }, h(Chevron, { className: "dsh-triggers-chevron", "data-open": expanded ? "true" : "false" }))
          )
        ),
        expanded ? h("div", { className: "dsh-triggers-detail", id: detailId },
          bindingPairChanged ? h("p", { className: "dsh-triggers-note" }, t("snapshotNote")) : null,
          binding === undefined && current !== undefined ? h("p", { className: "dsh-triggers-note" }, t("missingBindingNote")) : null,
          current !== undefined
            ? h(RunBody, {
              t: t, run: current, sessionId: props.sessionId, sessionsById: sessionsById,
              deliveries: props.deliveries, onAction: props.onAction,
              binding: binding, showConfig: true, templates: props.templates
            })
            : h("p", { className: "dsh-triggers-note" }, t("noRunHint")),
          current === undefined && binding !== undefined
            ? h(Disclosure, { label: t("configTitle") },
              h(ConfigFacts, {
                t: t, binding: binding, sessionsById: sessionsById, templates: props.templates
              })
            )
            : null,
          others.length > 0
            ? h(Disclosure, { label: t("otherRuns") + " (" + others.length + ")" },
              others.map(function (run) {
                return h(RunEntry, {
                  key: run.id, t: t, run: run, sessionId: props.sessionId,
                  sessionsById: sessionsById, deliveries: props.deliveries, onAction: props.onAction
                });
              })
            )
            : null
        ) : null
      );
    }

    function TriggerListView(props) {
      var t = props.t;
      var sessionId = props.sessionId;
      var data = props.data === undefined ? null : props.data;
      var loading = props.loading === true;
      var error = props.error;
      var actionError = props.actionError;
      var sessionsById = props.sessionsById || {};
      var scoped = data === null ? null : scopeSnapshot(data, sessionId);
      var groups = scoped === null ? [] : buildGroups(scoped, sessionId);
      var activeCount = scoped === null ? 0 : scoped.runs.filter(function (run) {
        return run.status === "active";
      }).length;

      var banner = null;
      if (actionError !== undefined) {
        banner = h("div", { className: "dsh-triggers-banner", role: "alert" },
          h("span", null, actionError),
          h("button", {
            type: "button", className: "dsh-triggers-iconbtn",
            "aria-label": t("close"), onClick: props.onDismissActionError
          }, "×")
        );
      } else if (error !== undefined && data !== null) {
        banner = h("div", { className: "dsh-triggers-banner", role: "alert" },
          h("span", null, error),
          h("button", {
            type: "button", className: "dsh-triggers-button", onClick: props.onRefresh
          }, t("retry"))
        );
      }

      var body;
      if (sessionId === undefined || sessionId === null || sessionId === "") {
        body = h("div", { className: "dsh-triggers-empty" }, h("p", { className: "dsh-triggers-empty-title" }, t("noSession")));
      } else if (data === null && loading) {
        body = h("div", { className: "dsh-triggers-list", "aria-busy": "true", "aria-label": t("loading") },
          [0, 1, 2].map(function (index) {
            return h("div", { key: index, className: "dsh-triggers-skeleton-row" },
              h("span", { className: "dsh-triggers-skeleton-dot" }),
              h("span", { className: "dsh-triggers-skeleton-text" },
                h("span", { className: "dsh-triggers-skeleton-line dsh-triggers-skeleton-title" }),
                h("span", { className: "dsh-triggers-skeleton-line dsh-triggers-skeleton-meta" })
              )
            );
          })
        );
      } else if (data === null) {
        body = h("div", { className: "dsh-triggers-empty" },
          h("p", { className: "dsh-triggers-empty-title" }, t("loadFailed", { message: error === undefined ? "" : error })),
          h("button", { type: "button", className: "dsh-triggers-button", onClick: props.onRefresh }, t("retry"))
        );
      } else if (groups.length === 0) {
        body = h("div", { className: "dsh-triggers-empty" },
          h("p", { className: "dsh-triggers-empty-title" }, t("emptyTitle")),
          h("p", { className: "dsh-triggers-empty-hint" }, t("emptyHint"))
        );
      } else {
        body = h("div", { className: "dsh-triggers-list" },
          groups.map(function (group) {
            return h(TriggerRow, {
              key: group.id, t: t, group: group, sessionId: sessionId,
              sessionsById: sessionsById, templates: scoped.templates,
              deliveries: scoped.deliveries, onAction: props.onAction
            });
          })
        );
      }

      // The host's [data-conversation-scroll] is the resident scrollport;
      // this view contributes normal-flow content and must not create a second
      // fixed-height scroll container (that nested overflow is what swallowed
      // wheel input). Chat uses the same ownership model.
      return h("div", { className: "dsh-triggers-root" },
        h("div", { className: "dsh-triggers-inner" },
          h("header", { className: "dsh-triggers-heading" },
            h("div", { className: "dsh-triggers-heading-text" },
              h("h1", { className: "dsh-triggers-title" }, t("title")),
              activeCount > 0
                ? h("p", { className: "dsh-triggers-summary" }, t("activeSummary", { n: activeCount }))
                : null
            ),
            h("button", {
              type: "button", className: "dsh-triggers-iconbtn", "aria-label": t("refresh"), title: t("refresh"),
              disabled: loading, onClick: props.onRefresh
            }, h(RefreshIcon))
          ),
          banner,
          h("div", { className: "dsh-triggers-body" }, body)
        )
      );
    }

    // --- the fetch/poll wrapper; TriggerListView stays pure for tests -------
    function TriggersView(props) {
      var t = props.t;
      var sessionId = props.sessionId === undefined || props.sessionId === null ? "" : String(props.sessionId);
      var sessionsById = props.useSessions(function (state) { return state.byId; });
      var stateResult = React.useState({ sessionId: sessionId, data: null, loading: true, error: undefined });
      var state = stateResult[0], setState = stateResult[1];
      var actionResult = React.useState(undefined);
      var actionError = actionResult[0], setActionError = actionResult[1];
      var generation = React.useRef(0);

      var load = React.useCallback(function () {
        if (sessionId === "") return Promise.resolve();
        var current = ++generation.current;
        return callRpc("state", { sessionId: sessionId }).then(function (data) {
          if (current !== generation.current) return;
          setState({ sessionId: sessionId, data: data, loading: false, error: undefined });
        }).catch(function (error) {
          if (current !== generation.current) return;
          setState(function (previous) {
            if (previous.sessionId === sessionId && previous.data !== null) {
              return { sessionId: sessionId, data: previous.data, loading: false, error: messageOf(error) };
            }
            return { sessionId: sessionId, data: null, loading: false, error: messageOf(error) };
          });
        });
      }, [sessionId]);

      React.useEffect(function () {
        generation.current += 1;
        setState({ sessionId: sessionId, data: null, loading: true, error: undefined });
        setActionError(undefined);
        void load();
        var timer = setInterval(function () {
          if (typeof document !== "undefined" && document.hidden) return;
          void load();
        }, POLL_MS);
        function onVisibility() {
          if (typeof document === "undefined" || document.hidden) return;
          void load();
        }
        if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
          document.addEventListener("visibilitychange", onVisibility);
        }
        return function () {
          generation.current += 1;
          clearInterval(timer);
          if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
            document.removeEventListener("visibilitychange", onVisibility);
          }
        };
      }, [load, sessionId]);

      var runAction = React.useCallback(function (endpoint, payload) {
        setActionError(undefined);
        return callRpc(endpoint, payload).then(function () {
          return load();
        }).then(function () {
          return true;
        }).catch(function (error) {
          setActionError(template(t("actionFailed"), { message: messageOf(error) }));
          return false;
        });
      }, [load, t]);

      var current = state.sessionId === sessionId
        ? state
        : { sessionId: sessionId, data: null, loading: true, error: undefined };

      return h(React.Fragment, null,
        // The view owns its stylesheet as part of its React tree instead of
        // patching the host document; unmounting the view removes it.
        h("style", { "data-dsh-triggers-styles": "" }, STYLES),
        h(TriggerListView, {
          t: t,
          sessionId: sessionId,
          data: current.data,
          loading: current.loading,
          error: current.error,
          actionError: actionError,
          sessionsById: sessionsById || {},
          onAction: runAction,
          onRefresh: function () { void load(); },
          onDismissActionError: function () { setActionError(undefined); }
        })
      );
    }

    // --- styles --------------------------------------------------------------
    // Colors and borders come from the live DSH theme tokens; the class prefix
    // keeps these rules away from every other plugin and from host internals.
    var STYLES = [
      ".dsh-triggers-root{box-sizing:border-box;width:100%;min-width:0;flex:none;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);}",
      ".dsh-triggers-inner{box-sizing:border-box;width:100%;max-width:820px;margin:0 auto;padding:40px 24px 72px;}",
      ".dsh-triggers-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;}",
      ".dsh-triggers-heading-text{min-width:0;}",
      ".dsh-triggers-title{margin:0;font-size:21px;line-height:1.35;font-weight:650;letter-spacing:-.02em;}",
      ".dsh-triggers-iconbtn{box-sizing:border-box;min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;font:inherit;}",
      ".dsh-triggers-iconbtn:disabled{opacity:.4;cursor:not-allowed;}",
      ".dsh-triggers-iconbtn:focus-visible,.dsh-triggers-row-main:focus-visible,.dsh-triggers-run-head:focus-visible,.dsh-triggers-disclosure-toggle:focus-visible,.dsh-triggers-button:focus-visible,.dsh-triggers-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}",
      ".dsh-triggers-iconbtn:focus-visible,.dsh-triggers-row-main:focus-visible,.dsh-triggers-run-head:focus-visible,.dsh-triggers-disclosure-toggle:focus-visible{outline-offset:-2px;}",
      ".dsh-triggers-banner{margin-top:18px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 8px 8px 12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5;}",
      ".dsh-triggers-banner span{min-width:0;overflow-wrap:anywhere;}",
      ".dsh-triggers-list{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}",
      ".dsh-triggers-item+.dsh-triggers-item{border-top:1px solid var(--dsw-alias-border-l1);}",
      ".dsh-triggers-row{display:flex;align-items:stretch;min-height:64px;}",
      ".dsh-triggers-row-main{box-sizing:border-box;flex:1;min-width:0;display:flex;align-items:center;gap:12px;padding:12px 4px 12px 18px;border:0;border-radius:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;}",
      ".dsh-triggers-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary);}",
      ".dsh-triggers-dot[data-tone=success]{background:var(--dsw-alias-state-success-primary);}",
      ".dsh-triggers-dot[data-tone=warn]{background:var(--dsw-alias-state-warn-primary);}",
      ".dsh-triggers-dot[data-tone=error]{background:var(--dsw-alias-state-error-primary);}",
      ".dsh-triggers-row-text{min-width:0;flex:1;}",
      ".dsh-triggers-row-title{display:block;font-size:14px;font-weight:600;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".dsh-triggers-row-meta{margin-top:4px;display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:12px;line-height:1.45;color:var(--dsw-alias-label-secondary);}",
      ".dsh-triggers-role{color:var(--dsw-alias-label-primary);font-weight:500;}",
      ".dsh-triggers-sep{opacity:.55;}",
      ".dsh-triggers-muted{font-size:12px;color:var(--dsw-alias-label-secondary);}",
      ".dsh-triggers-side{display:flex;align-items:center;gap:2px;padding-right:8px;flex:none;}",
      ".dsh-triggers-state{font-size:12px;line-height:1.4;white-space:nowrap;color:var(--dsw-alias-state-idle-primary);}",
      ".dsh-triggers-state[data-tone=success]{color:var(--dsw-alias-state-success-primary);}",
      ".dsh-triggers-state[data-tone=warn]{color:var(--dsw-alias-state-warn-primary);}",
      ".dsh-triggers-state[data-tone=error]{color:var(--dsw-alias-state-error-primary);}",
      ".dsh-triggers-chevron{transition:transform .16s;flex:none;}",
      ".dsh-triggers-chevron[data-open=true]{transform:rotate(180deg);}",
      ".dsh-triggers-detail{border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);padding:14px 20px 18px 37px;}",
      ".dsh-triggers-summary{margin:6px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);}",
      ".dsh-triggers-body{margin-top:22px;}",
      ".dsh-triggers-disclosure{margin-top:14px;}",
      ".dsh-triggers-disclosure-toggle{box-sizing:border-box;min-width:44px;min-height:44px;display:inline-flex;align-items:center;gap:6px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;}",
      ".dsh-triggers-disclosure-body{margin-top:2px;}",
      ".dsh-triggers-note{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);}",
      ".dsh-triggers-note+.dsh-triggers-note{margin-top:8px;}",
      ".dsh-triggers-hint{margin:8px 0 0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);}",
      ".dsh-triggers-error-text{flex:1 1 100%;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;}",
      ".dsh-triggers-run+.dsh-triggers-run{margin-top:4px;}",
      ".dsh-triggers-run-head{box-sizing:border-box;width:100%;min-height:44px;display:flex;align-items:center;gap:10px;padding:8px 0;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;}",
      ".dsh-triggers-chip{display:inline-flex;align-items:center;flex:none;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}",
      ".dsh-triggers-chip[data-tone=success]{color:var(--dsw-alias-state-success-primary);}",
      ".dsh-triggers-chip[data-tone=warn]{color:var(--dsw-alias-state-warn-primary);}",
      ".dsh-triggers-chip[data-tone=error]{color:var(--dsw-alias-state-error-primary);}",
      ".dsh-triggers-run-title{flex:1;min-width:0;font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".dsh-triggers-run-meta{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}",
      ".dsh-triggers-run-body{padding:2px 0 12px;}",
      ".dsh-triggers-reason{margin:0 0 2px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}",
      ".dsh-triggers-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}",
      ".dsh-triggers-button{box-sizing:border-box;min-height:44px;display:inline-flex;align-items:center;justify-content:center;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:500;white-space:nowrap;cursor:pointer;}",
      ".dsh-triggers-button[data-variant=primary]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}",
      ".dsh-triggers-button[data-variant=quiet]{border-color:transparent;color:var(--dsw-alias-label-secondary);}",
      ".dsh-triggers-button:disabled{opacity:.4;cursor:not-allowed;}",
      ".dsh-triggers-note-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}",
      ".dsh-triggers-input{box-sizing:border-box;flex:1 1 220px;min-width:0;min-height:44px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:16px;}",
      ".dsh-triggers-input::placeholder{color:var(--dsw-alias-label-secondary);}",
      ".dsh-triggers-subsection{margin-top:14px;}",
      ".dsh-triggers-sublabel{margin-bottom:4px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);}",
      ".dsh-triggers-history-row{display:grid;grid-template-columns:70px minmax(0,1fr);gap:10px;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);}",
      ".dsh-triggers-time{font-variant-numeric:tabular-nums;color:var(--dsw-alias-state-idle-primary);white-space:nowrap;}",
      ".dsh-triggers-history-text{min-width:0;overflow-wrap:anywhere;}",
      ".dsh-triggers-delivery{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1);}",
      ".dsh-triggers-config{margin-top:20px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1);}",
      ".dsh-triggers-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 24px;margin-top:8px;}",
      ".dsh-triggers-fact{min-width:0;}",
      ".dsh-triggers-fact-wide{grid-column:1 / -1;}",
      ".dsh-triggers-fact-label{font-size:11px;line-height:1.5;color:var(--dsw-alias-state-idle-primary);}",
      ".dsh-triggers-fact-value{margin-top:2px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}",
      ".dsh-triggers-empty{padding:36px 20px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);text-align:center;}",
      ".dsh-triggers-empty-title{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary);}",
      ".dsh-triggers-empty-hint{margin:6px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);}",
      ".dsh-triggers-empty .dsh-triggers-button{margin-top:14px;}",
      ".dsh-triggers-skeleton-row{display:flex;align-items:center;gap:12px;padding:16px 18px;min-height:64px;}",
      ".dsh-triggers-skeleton-row+.dsh-triggers-skeleton-row{border-top:1px solid var(--dsw-alias-border-l1);}",
      ".dsh-triggers-skeleton-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-bg-layer-2);}",
      ".dsh-triggers-skeleton-text{flex:1;min-width:0;}",
      ".dsh-triggers-skeleton-line{display:block;height:10px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);animation:dsh-triggers-pulse 1.4s ease-in-out infinite;}",
      ".dsh-triggers-skeleton-title{width:44%;}",
      ".dsh-triggers-skeleton-meta{width:68%;margin-top:8px;height:8px;}",
      "@keyframes dsh-triggers-pulse{0%,100%{opacity:.55}50%{opacity:1}}",
      "@media(max-width:600px){.dsh-triggers-inner{padding:28px 16px 56px;}.dsh-triggers-title{font-size:19px;}.dsh-triggers-row-main{padding-left:14px;gap:10px;}.dsh-triggers-side{padding-right:4px;gap:0;}.dsh-triggers-state{font-size:11px;}.dsh-triggers-detail{padding:14px 16px 18px;}.dsh-triggers-facts{grid-template-columns:1fr;gap:10px;}.dsh-triggers-run-meta{display:none;}.dsh-triggers-history-row{grid-template-columns:58px minmax(0,1fr);gap:8px;}.dsh-triggers-actions .dsh-triggers-button{flex:1 1 auto;}.dsh-triggers-note-row .dsh-triggers-input{flex-basis:100%;}}",
      "@media(hover:hover){.dsh-triggers-iconbtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}.dsh-triggers-row:hover{background:var(--dsw-alias-bg-layer-2);}.dsh-triggers-run-head:hover{background:var(--dsw-alias-bg-layer-2);}.dsh-triggers-disclosure-toggle:hover{background:var(--dsw-alias-bg-layer-2);}.dsh-triggers-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);}}",
      "@media(prefers-reduced-motion:reduce){.dsh-triggers-chevron{transition:none;}.dsh-triggers-skeleton-line{animation:none;}}"
    ].join("");

    function apply(ctx) {
      ctx.effect(function () { return ctx.locale.register(LOCALE_NS, { zh: zh, en: en }); }, "dsh-triggers: locale");
      var t = ctx.locale.bind(LOCALE_NS);
      ctx.slots.inject("conversation.view", function () {
        return ctx.slots.register({
          name: "conversation.view",
          id: "triggers",
          order: 30,
          locale: LOCALE_NS,
          label: function () { return t("viewLabel"); }
        }, function (props) {
          return h(TriggersView, Object.assign({}, props, { t: t }));
        });
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  }
});
