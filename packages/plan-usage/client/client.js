// Client half of dsh-plan-usage: a Settings section showing the GLM
// coding plan's quota windows — the rolling five-hour bar, the weekly bar,
// and (when the plan reports it) the monthly MCP budget — each with its
// consumed percentage and reset countdown. Reads through this package's own
// channel (`/dsh-plan-usage/quota`), refreshes on demand and once a
// minute while visible. Plain JavaScript (no JSX), evaluated by the DSH
// client module loader.
window.__ModuleLoader__.load({
  id: "dsh-plan-usage",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    var LOCALE_NS = "plan-usage";
    var RPC_BASE = "/dsh-plan-usage";
    var AUTO_REFRESH_MS = 60 * 1000;

    var en = {
      nav: "Coding Plan Usage",
      title: "Coding Plan Usage",
      intro: "GLM coding-plan quota windows, with reset countdowns. Mounted with dsh-auto-continue, quota-limited sessions resume automatically at the reported reset.",
      refresh: "Refresh",
      refreshing: "Refreshing…",
      fiveHour: "5-hour window",
      windowOfSize: "{size} window",
      weekly: "Weekly window",
      monthlyMcp: "Monthly MCP tools",
      resetsIn: "resets in {duration}",
      resetOverdue: "reset pending",
      noReset: "no reset reported",
      consumed: "{percent}% used",
      usedOfTotal: "{used} / {total} used",
      fetchedAt: "updated {when}",
      fetchFailed: "Quota unavailable (see host logs).",
      notMonitored: "No API key resolved for this provider's quota monitor.",
      level: "plan: {level}"
    };

    var zh = {
      nav: "Coding 套餐用量",
      title: "Coding 套餐用量",
      intro: "GLM Coding 套餐的配额窗口与重置倒计时。搭配 dsh-auto-continue 时，限额会话会在重置点自动续跑。",
      refresh: "刷新",
      refreshing: "刷新中…",
      fiveHour: "5 小时窗口",
      windowOfSize: "{size} 窗口",
      weekly: "周窗口",
      monthlyMcp: "月度 MCP 工具",
      resetsIn: "{duration}后重置",
      resetOverdue: "等待重置生效",
      noReset: "未上报重置时间",
      consumed: "已用 {percent}%",
      usedOfTotal: "已用 {used} / {total}",
      fetchedAt: "更新于 {when}",
      fetchFailed: "用量暂不可用（详见宿主日志）。",
      notMonitored: "未解析到该服务商配额监控的 API Key。",
      level: "套餐：{level}"
    };

    function relTime(t, at) {
      var diff = Date.now() - (at || 0);
      var s = Math.floor(diff / 1000);
      if (s < 5) return t("checkedJustNow");
      if (s < 60) return t("secondsAgo", { n: s });
      var m = Math.floor(s / 60);
      if (m < 60) return t("minutesAgo", { n: m });
      return t("hoursAgo", { n: Math.floor(m / 60) });
    }

    // Add "just now / n s ago / …" — the shared locale keys oauth-providers
    // also uses locally; defined here so the section is self-contained.
    en.checkedJustNow = "just now";
    en.secondsAgo = "{n}s ago";
    en.minutesAgo = "{n}m ago";
    en.hoursAgo = "{n}h ago";
    zh.checkedJustNow = "刚刚";
    zh.secondsAgo = "{n} 秒前";
    zh.minutesAgo = "{n} 分钟前";
    zh.hoursAgo = "{n} 小时前";

    function fmtDuration(ms) {
      if (ms < 0) ms = 0;
      var s = Math.floor(ms / 1000);
      var d = Math.floor(s / 86400);
      s -= d * 86400;
      var h = Math.floor(s / 3600);
      s -= h * 3600;
      var m = Math.floor(s / 60);
      s -= m * 60;
      if (d > 0) return d + "d " + h + "h";
      if (h > 0) return h + "h " + m + "m";
      if (m > 0) return m + "m " + s + "s";
      return s + "s";
    }

    function fmtCount(n) {
      if (typeof n !== "number" || !isFinite(n)) return "—";
      if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
      if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
      return String(Math.round(n));
    }

    var rpcSeq = 0;
    function callQuota(refresh) {
      rpcSeq += 1;
      return fetch(RPC_BASE + "/quota", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "client-request",
          rpcId: "plan-usage-" + String(rpcSeq),
          method: "quota",
          payload: { refresh: !!refresh }
        })
      }).then(function (r) { return r.json(); }).then(function (body) {
        if (body && body.result) return body.result;
        return { ok: false, error: { message: "unexpected channel response" } };
      });
    }

    // "5h" / "2.5h" / "45m" from API-reported window minutes, when present.
    function fmtWindowSize(minutes) {
      if (!minutes || minutes <= 0) return null;
      if (minutes < 60) return minutes + "m";
      var h = minutes / 60;
      return (h === Math.round(h) ? String(Math.round(h)) : h.toFixed(1)) + "h";
    }

    function windowLabel(t, base, w) {
      var size = w && w.windowMinutes ? fmtWindowSize(w.windowMinutes) : null;
      return size ? t("windowOfSize", { size: size }) : base;
    }

    function barColor(percent) {
      if (percent >= 100) return "var(--dsw-alias-state-error-primary)";
      if (percent >= 80) return "var(--dsw-alias-state-warn-label)";
      return "var(--dsw-alias-brand-primary)";
    }

    function WindowBar(props) {
      var t = props.t;
      var label = props.label;
      var w = props.window || {};
      var nowTick = props.nowTick;
      var percent = typeof w.percent === "number" ? w.percent : null;

      var meta;
      if (percent === null) {
        meta = t("noReset");
      } else {
        var used = typeof w.used === "number" && typeof w.total === "number" && w.total > 0
          ? t("usedOfTotal", { used: fmtCount(w.used), total: fmtCount(w.total) })
          : t("consumed", { percent: percent });
        var reset;
        if (typeof w.resetAt === "number") {
          var remaining = w.resetAt - nowTick;
          reset = remaining > 0
            ? t("resetsIn", { duration: fmtDuration(remaining) })
            : t("resetOverdue");
        } else {
          reset = t("noReset");
        }
        meta = used + " · " + reset;
      }

      return React.createElement("div", { style: { marginBottom: 12 } },
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", marginBottom: 4 } },
          React.createElement("span", { style: { fontSize: 13, fontWeight: 600, lineHeight: "20px", color: "var(--dsw-alias-label-primary)" } }, label),
          React.createElement("span", { style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" } }, meta)
        ),
        React.createElement("div", { style: { boxSizing: "border-box", height: 8, borderRadius: 4, background: "var(--dsw-alias-bg-layer-2)", overflow: "hidden" } },
          React.createElement("div", {
            style: {
              height: "100%",
              width: (percent === null ? 0 : Math.min(100, Math.max(0, percent))) + "%",
              borderRadius: 4,
              background: percent === null ? "transparent" : barColor(percent),
              transition: "width .3s ease"
            }
          })
        )
      );
    }

    function ProviderCard(props) {
      var t = props.t;
      var view = props.view;
      var nowTick = props.nowTick;
      var snapshot = view.snapshot;

      return React.createElement("div", { style: { border: "1px solid var(--dsw-alias-border-l4)", borderRadius: 16, padding: "12px 14px", marginBottom: 14 } },
        React.createElement("div", { style: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 } },
          React.createElement("h3", { style: { margin: 0, fontSize: 14, fontWeight: 600, lineHeight: "22px", color: "var(--dsw-alias-label-primary)" } }, view.provider),
          snapshot && snapshot.level
            ? React.createElement("span", { style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" } }, t("level", { level: snapshot.level }))
            : null,
          snapshot
            ? React.createElement("span", { style: { marginLeft: "auto", fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" } }, t("fetchedAt", { when: relTime(t, snapshot.fetchedAt) }))
            : null
        ),
        !view.monitored
          ? React.createElement("div", { style: { fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-secondary)" } }, t("notMonitored"))
          : snapshot
            ? [
              React.createElement(WindowBar, { key: "5h", t: t, label: windowLabel(t, t("fiveHour"), snapshot.fiveHour), window: snapshot.fiveHour, nowTick: nowTick }),
              React.createElement(WindowBar, { key: "weekly", t: t, label: windowLabel(t, t("weekly"), snapshot.weekly), window: snapshot.weekly, nowTick: nowTick }),
              snapshot.monthlyMcp
                ? React.createElement(WindowBar, { key: "mcp", t: t, label: t("monthlyMcp"), window: snapshot.monthlyMcp, nowTick: nowTick })
                : null
            ]
            : React.createElement("div", { style: { fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-state-warn-label)" } }, view.error ? view.error : t("fetchFailed"))
      );
    }

    function Section(props) {
      var operations = props.operations;
      var t = props.t;

      var _v = React.useState(null);
      var views = _v[0];
      var setViews = _v[1];
      var _b = React.useState(false);
      var busy = _b[0];
      var setBusy = _b[1];
      var _n = React.useState(Date.now());
      var nowTick = _n[0];
      var setNowTick = _n[1];
      var aliveRef = React.useRef(true);

      function load(refresh) {
        if (refresh) setBusy(true);
        return operations.quota(refresh).then(function (result) {
          if (result.ok && aliveRef.current) setViews(result.value.providers || []);
          return result;
        }).catch(function () { return null; }).then(function (r) {
          if (refresh) setBusy(false);
          return r;
        });
      }

      React.useEffect(function () {
        aliveRef.current = true;
        load(false);
        var poll = setInterval(function () { if (aliveRef.current) load(false); }, AUTO_REFRESH_MS);
        var tick = setInterval(function () { if (aliveRef.current) setNowTick(Date.now()); }, 1000);
        return function () {
          aliveRef.current = false;
          clearInterval(poll);
          clearInterval(tick);
        };
      }, []);

      return React.createElement("div", { style: { padding: "0 24px 24px", maxWidth: 720 } },
        React.createElement("h2", { style: { margin: "0 0 4px", fontSize: 16, fontWeight: 600, lineHeight: "24px", color: "var(--dsw-alias-label-primary)" } }, t("title")),
        React.createElement("p", { style: { margin: "0 0 16px", fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-tertiary)" } }, t("intro")),
        React.createElement("div", { style: { marginBottom: 16 } },
          React.createElement("button", {
            type: "button",
            onClick: function () { load(true); },
            disabled: busy,
            style: {
              boxSizing: "border-box", height: 28, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 14,
              padding: "0 12px", fontSize: 12, lineHeight: "18px", cursor: "pointer",
              background: "transparent", color: "var(--dsw-alias-label-primary)"
            }
          }, busy ? t("refreshing") : t("refresh"))
        ),
        views === null
          ? React.createElement("div", { style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" } }, "…")
          : views.map(function (view) {
            return React.createElement(ProviderCard, { key: view.provider, t: t, view: view, nowTick: nowTick });
          })
      );
    }

    function apply(ctx) {
      ctx.effect(function () { return ctx.locale.register(LOCALE_NS, { zh: zh, en: en }); }, "dsh-plan-usage: locale");
      var t = ctx.locale.bind(LOCALE_NS);
      var operations = {
        quota: function (refresh) { return callQuota(refresh); }
      };
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "dsh-plan-usage",
          order: 21,
          label: function () { return t("nav"); },
          inject: function () {
            return { operations: operations, t: t };
          }
        }, Section);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  }
});
