// Client half of dsh-context-audit: a sidebar panel (like Plugins / Tasks)
// whose main page reports, over the local session event logs:
//
// - per provider/model route: requests, prompt totals, cache-read share and
//   hit rate, output tokens — the numbers cache-affinity A/B needs;
// - per tool: call counts, errored results, failure rate, average and max
//   duration, distinct sessions, and the error-code distribution — the
//   numbers that show which tools (ours or the harness's) misbehave;
// - the heaviest sessions by uncached input.
//
// Reads through this package's own channel (`/dsh-context-audit/report`).
// Plain JavaScript (no JSX), evaluated by the DSH client module loader.
window.__ModuleLoader__.load({
  id: "dsh-context-audit",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    var LOCALE_NS = "context-audit";
    var RPC_BASE = "/dsh-context-audit";
    var PANEL_ID = "dsh-context-audit";
    var WINDOWS = [7, 14, 30];

    var en = {
      panel: "Context Audit",
      title: "Context Audit",
      intro: "Cache-hit rates, token usage, and per-tool call/failure statistics over the local session event logs. Nothing leaves this machine.",
      refresh: "Refresh",
      refreshing: "Scanning…",
      routes: "Routes (cache hit = cacheRead / (cacheRead + uncached))",
      tools: "Tools (failure = isError / completed)",
      sessions: "Heaviest sessions (by uncached input)",
      colRoute: "route", colRequests: "reqs", colPrompt: "prompt", colCacheRead: "cache read",
      colHit: "hit", colOutput: "output", colSessions: "sessions",
      colTool: "tool", colCalls: "calls", colErrors: "errors", colFail: "fail",
      colAvg: "avg", colMax: "max", colUnfinished: "no result",
      colSession: "session", colWindow: "time range", colUncached: "uncached",
      errorCodes: "error codes:",
      lastDays: "{n}d", allHistory: "all",
      fetchFailed: "Scan failed: {message}",
      empty: "No model or tool usage in this window.",
      moreRows: "…and {n} more"
    };

    var zh = {
      panel: "上下文审计",
      title: "上下文审计",
      intro: "基于本机会话事件日志的缓存命中率、token 用量与各工具调用/失败统计。数据不离开本机。",
      refresh: "刷新",
      refreshing: "扫描中…",
      routes: "路由汇总（命中率 = cacheRead / (cacheRead + uncached输入)）",
      tools: "工具汇总（失败率 = isError / 已完成结果）",
      sessions: "输入量最大的会话（按 uncached 输入）",
      colRoute: "路由", colRequests: "请求", colPrompt: "prompt总量", colCacheRead: "缓存命中",
      colHit: "命中率", colOutput: "输出", colSessions: "会话数",
      colTool: "工具", colCalls: "调用", colErrors: "失败", colFail: "失败率",
      colAvg: "平均", colMax: "最长", colUnfinished: "无结果",
      colSession: "会话", colWindow: "时间范围", colUncached: "uncached",
      errorCodes: "错误码分布：",
      lastDays: "{n}天", allHistory: "全部",
      fetchFailed: "扫描失败：{message}",
      empty: "窗口内没有模型或工具用量。",
      moreRows: "…还有 {n} 项"
    };

    function template(text, vars) {
      return String(text).replace(/\{(\w+)\}/g, function (_, key) {
        return vars[key] === undefined ? "" : String(vars[key]);
      });
    }

    function fmtTokens(n) {
      if (typeof n !== "number" || !isFinite(n)) return "—";
      if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
      if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
      return String(Math.round(n));
    }

    function fmtDuration(ms) {
      if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "—";
      if (ms >= 60000) return (ms / 60000).toFixed(1) + "m";
      if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
      return Math.round(ms) + "ms";
    }

    function fmtClock(ms) {
      var d = new Date(ms);
      function p(n) { return String(n).padStart(2, "0"); }
      return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    function fmtHit(cacheRead, uncached) {
      var total = cacheRead + uncached;
      return total === 0 ? "—" : ((cacheRead / total) * 100).toFixed(1) + "%";
    }

    var rpcSeq = 0;
    function callReport(days) {
      rpcSeq += 1;
      var payload = {};
      if (typeof days === "number") payload.days = days;
      return fetch(RPC_BASE + "/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "client-request",
          rpcId: "context-audit-" + String(rpcSeq),
          method: "report",
          payload: payload
        })
      }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      }).then(function (envelope) {
        var result = envelope && envelope.result;
        if (!result || result.ok !== true) {
          throw new Error((result && result.error && result.error.message) || "bad response");
        }
        return result.value;
      });
    }

    var th = { textAlign: "left", fontWeight: 500, fontSize: 12, padding: "6px 10px", whiteSpace: "nowrap", color: "var(--dsw-alias-label-secondary)" };
    var thr = Object.assign({}, th, { textAlign: "right" });
    var td = { fontSize: 12, padding: "6px 10px", whiteSpace: "nowrap", color: "var(--dsw-alias-label-primary)" };
    var tdr = Object.assign({}, td, { textAlign: "right" });
    var tableStyle = { borderCollapse: "collapse", width: "100%" };
    var tableBox = { minWidth: "min(560px, 90vw)", overflowX: "auto", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8 };
    var sectionTitle = { fontSize: 13, fontWeight: 600, margin: "18px 0 8px", color: "var(--dsw-alias-label-primary)" };
    var chip = {
      display: "inline-block", margin: "2px 6px 2px 0", padding: "2px 8px", fontSize: 11,
      border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, color: "var(--dsw-alias-label-secondary)"
    };
    var buttonStyle = {
      boxSizing: "border-box", minHeight: 28, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 14,
      padding: "4px 12px", fontSize: 12, lineHeight: "18px", cursor: "pointer",
      background: "transparent", color: "var(--dsw-alias-label-primary)"
    };

    function RoutesTable(props) {
      var t = props.t, rows = props.rows;
      return React.createElement("div", { style: tableBox },
        React.createElement("table", { style: tableStyle },
          React.createElement("thead", null, React.createElement("tr", null,
            React.createElement("th", { style: th }, t("colRoute")),
            React.createElement("th", { style: thr }, t("colRequests")),
            React.createElement("th", { style: thr }, t("colPrompt")),
            React.createElement("th", { style: thr }, t("colCacheRead")),
            React.createElement("th", { style: thr }, t("colHit")),
            React.createElement("th", { style: thr }, t("colOutput")),
            React.createElement("th", { style: thr }, t("colSessions"))
          )),
          React.createElement("tbody", null, rows.map(function (m) {
            return React.createElement("tr", { key: m.provider + "/" + m.model },
              React.createElement("td", { style: td }, m.provider + "/" + m.model),
              React.createElement("td", { style: tdr }, m.requests),
              React.createElement("td", { style: tdr }, fmtTokens(m.uncachedInput + m.cacheRead)),
              React.createElement("td", { style: tdr }, fmtTokens(m.cacheRead)),
              React.createElement("td", { style: tdr }, fmtHit(m.cacheRead, m.uncachedInput)),
              React.createElement("td", { style: tdr }, fmtTokens(m.output)),
              React.createElement("td", { style: tdr }, m.sessions)
            );
          }))
        )
      );
    }

    function ToolsTable(props) {
      var t = props.t, rows = props.rows;
      return React.createElement("div", { style: tableBox },
        React.createElement("table", { style: tableStyle },
          React.createElement("thead", null, React.createElement("tr", null,
            React.createElement("th", { style: th }, t("colTool")),
            React.createElement("th", { style: thr }, t("colCalls")),
            React.createElement("th", { style: thr }, t("colErrors")),
            React.createElement("th", { style: thr }, t("colFail")),
            React.createElement("th", { style: thr }, t("colAvg")),
            React.createElement("th", { style: thr }, t("colMax")),
            React.createElement("th", { style: thr }, t("colUnfinished")),
            React.createElement("th", { style: thr }, t("colSessions"))
          )),
          React.createElement("tbody", null, rows.map(function (tool) {
            return React.createElement("tr", { key: tool.name },
              React.createElement("td", { style: td }, tool.name),
              React.createElement("td", { style: tdr }, tool.calls),
              React.createElement("td", { style: tdr }, tool.errors),
              React.createElement("td", { style: tdr }, tool.completed === 0 ? "—" : ((tool.errors / tool.completed) * 100).toFixed(1) + "%"),
              React.createElement("td", { style: tdr }, tool.completed === 0 ? "—" : fmtDuration(tool.totalDurationMs / tool.completed)),
              React.createElement("td", { style: tdr }, tool.maxDurationMs > 0 ? fmtDuration(tool.maxDurationMs) : "—"),
              React.createElement("td", { style: tdr }, tool.unfinished),
              React.createElement("td", { style: tdr }, tool.sessions)
            );
          }))
        )
      );
    }

    function SessionsTable(props) {
      var t = props.t, rows = props.rows;
      return React.createElement("div", { style: tableBox },
        React.createElement("table", { style: tableStyle },
          React.createElement("thead", null, React.createElement("tr", null,
            React.createElement("th", { style: th }, t("colSession")),
            React.createElement("th", { style: th }, t("colWindow")),
            React.createElement("th", { style: th }, t("colRoute")),
            React.createElement("th", { style: thr }, t("colRequests")),
            React.createElement("th", { style: thr }, t("colUncached")),
            React.createElement("th", { style: thr }, t("colHit"))
          )),
          React.createElement("tbody", null, rows.map(function (s) {
            return React.createElement("tr", { key: s.id },
              React.createElement("td", { style: td }, s.title || s.id.slice(0, 12)),
              React.createElement("td", { style: td }, fmtClock(s.first) + "→" + fmtClock(s.last)),
              React.createElement("td", { style: td }, (s.routes || []).slice(0, 2).join(" + ")),
              React.createElement("td", { style: tdr }, s.requests),
              React.createElement("td", { style: tdr }, fmtTokens(s.uncachedInput)),
              React.createElement("td", { style: tdr }, fmtHit(s.cacheRead, s.uncachedInput))
            );
          }))
        )
      );
    }

    /** The panel's main page; `t` arrives as a prop from the apply binding. */
    function ContextAuditPage(props) {
      var t = props.t;
      var state = React.useState(14);
      var days = state[0], setDays = state[1];
      var dataState = React.useState(null);
      var report = dataState[0], setReport = dataState[1];
      var errState = React.useState(undefined);
      var error = errState[0], setError = errState[1];
      var busyState = React.useState(false);
      var busy = busyState[0], setBusy = busyState[1];

      var load = React.useCallback(function () {
        setBusy(true);
        setError(undefined);
        callReport(days).then(function (value) {
          setReport(value);
        }).catch(function (err) {
          setError(err && err.message ? err.message : String(err));
        }).finally(function () {
          setBusy(false);
        });
      }, [days]);

      React.useEffect(load, [load]);

      var controls = React.createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
        WINDOWS.map(function (w) {
          return React.createElement("button", {
            key: String(w), style: Object.assign({}, buttonStyle, days === w ? { background: "var(--dsw-alias-fill-secondary)" } : {}),
            onClick: function () { setDays(w); }
          }, template(t("lastDays"), { n: w }));
        }),
        React.createElement("button", {
          style: Object.assign({}, buttonStyle, days === undefined ? { background: "var(--dsw-alias-fill-secondary)" } : {}),
          onClick: function () { setDays(undefined); }
        }, t("allHistory")),
        React.createElement("button", { style: buttonStyle, onClick: load }, busy ? t("refreshing") : t("refresh"))
      );

      var body;
      if (error !== undefined) {
        body = React.createElement("div", { style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" } },
          template(t("fetchFailed"), { message: error }));
      } else if (report === null) {
        body = React.createElement("div", { style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" } }, "…");
      } else if (!report.models.length && !report.tools.length) {
        body = React.createElement("div", { style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" } }, t("empty"));
      } else {
        var parts = [];
        if (report.models.length) {
          parts.push(React.createElement("div", { key: "routes", style: sectionTitle }, t("routes")));
          parts.push(React.createElement(RoutesTable, { key: "routes-table", t: t, rows: report.models.slice(0, 20) }));
        }
        if (report.tools.length) {
          parts.push(React.createElement("div", { key: "tools", style: sectionTitle }, t("tools")));
          parts.push(React.createElement(ToolsTable, { key: "tools-table", t: t, rows: report.tools.slice(0, 30) }));
          var withCodes = report.tools.filter(function (tool) { return tool.errorCodes && tool.errorCodes.length; }).slice(0, 8);
          if (withCodes.length) {
            parts.push(React.createElement("div", { key: "codes", style: { marginTop: 8, fontSize: 12 } },
              React.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)" } }, t("errorCodes")),
              withCodes.map(function (tool) {
                return React.createElement("span", { key: tool.name, style: chip },
                  tool.name + ": " + tool.errorCodes.map(function (pair) { return pair[0] + "×" + pair[1]; }).join(", "));
              })
            ));
          }
          if (report.tools.length > 30) {
            parts.push(React.createElement("div", { key: "more-tools", style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", marginTop: 4 } },
              template(t("moreRows"), { n: report.tools.length - 30 }));
          }
        }
        if (report.sessions.length) {
          parts.push(React.createElement("div", { key: "sessions", style: sectionTitle }, t("sessions")));
          parts.push(React.createElement(SessionsTable, { key: "sessions-table", t: t, rows: report.sessions }));
        }
        body = parts;
      }

      return React.createElement("div", { style: { padding: 16, maxWidth: 960, margin: "0 auto" } },
        React.createElement("h2", { style: { fontSize: 16, margin: "0 0 4px" } }, t("title")),
        React.createElement("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", marginBottom: 12 } }, t("intro")),
        controls,
        React.createElement("div", { style: { marginTop: 8 } }, body)
      );
    }

    /** The sidebar entry's icon (a small bar chart). */
    function ContextAuditIcon() {
      return React.createElement("svg", {
        viewBox: "0 0 24 24", width: 18, height: 18, fill: "none",
        stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round"
      },
        React.createElement("path", { d: "M4 20v-6" }),
        React.createElement("path", { d: "M10 20V8" }),
        React.createElement("path", { d: "M16 20v-10" }),
        React.createElement("path", { d: "M22 20v-4" }),
        React.createElement("path", { d: "M2 20h22" })
      );
    }

    function apply(ctx) {
      ctx.effect(function () { return ctx.locale.register(LOCALE_NS, { zh: zh, en: en }); }, "dsh-context-audit: locale");
      var t = ctx.locale.bind(LOCALE_NS);
      var boundPage = function () {
        return React.createElement(ContextAuditPage, { t: t });
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
          order: 20,
          locale: LOCALE_NS,
          label: function () { return t("panel"); }
        }, ContextAuditIcon);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  }
});
