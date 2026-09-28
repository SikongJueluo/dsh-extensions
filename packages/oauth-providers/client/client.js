// Client half of dsh-oauth-providers: a Settings section listing every
// OAuth-authenticated provider this package ships (today: ChatGPT). Plain
// JavaScript (no JSX), evaluated by the DSH client module loader. Registers
// the `settings.section` slot, localizes through the DSH locale service,
// reads provider state through the typed Client Remote wire, and drives each
// provider's sign-in through this package's own channel
// (`/dsh-oauth-providers`): begin → poll the notice/prompt → submit or
// decline — the pi-style "open this link, paste the code if the redirect
// fails" login.
//
// Derived from werifu/dsh-oai-oauth (MIT) — see THIRD-PARTY-NOTICE.md.
window.__ModuleLoader__.load({
  id: "dsh-oauth-providers",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    var LOCALE_NS = "oauth-providers";
    var RPC_BASE = "/dsh-oauth-providers";

    var en = {
      nav: "OAuth Providers",
      title: "OAuth Providers",
      intro: "Use your model subscriptions — sign in with each provider's account, no API keys.",
      statusLoading: "Checking…",
      statusOk: "Signed in · checked {when}",
      checkedJustNow: "just now",
      secondsAgo: "{n}s ago",
      minutesAgo: "{n}m ago",
      hoursAgo: "{n}h ago",
      statusUnknown: "Not registered or unavailable.",
      statusNotSignedIn: "Not signed in — click \"Sign in\".",
      statusRefreshFailed: "Token refresh failed: {detail} — sign in again.",
      statusUnreachable: "Backend unreachable (network/proxy): {detail}",
      statusHttpError: "Backend error: {detail}",
      statusModelsError: "Cannot load the model catalog: {detail}",
      statusCheckError: "Status check failed: {detail}",
      refresh: "Refresh",
      signIn: "Sign in",
      signOut: "Sign out",
      openBrowser: "Open browser",
      working: "Working…",
      signinTitle: "Sign in",
      pasteLabel: "If the browser cannot redirect back, paste the redirected URL or the code here:",
      submit: "Submit",
      abandon: "Cancel sign-in",
      signinCancelled: "Sign-in cancelled.",
      signinFailed: "Sign-in failed: {detail}"
    };

    var zh = {
      nav: "OAuth 登录",
      title: "OAuth 登录",
      intro: "使用你的模型订阅 —— 每个厂商用自己的账号登录，无需 API Key。",
      statusLoading: "检测中…",
      statusOk: "已登录 · 检测于 {when}",
      checkedJustNow: "刚刚",
      secondsAgo: "{n} 秒前",
      minutesAgo: "{n} 分钟前",
      hoursAgo: "{n} 小时前",
      statusUnknown: "未注册或不可用。",
      statusNotSignedIn: "未登录 —— 点击「登录」。",
      statusRefreshFailed: "令牌刷新失败：{detail} —— 请重新登录。",
      statusUnreachable: "后端不可达（网络/代理）：{detail}",
      statusHttpError: "后端返回错误：{detail}",
      statusModelsError: "无法读取模型目录：{detail}",
      statusCheckError: "状态检测失败：{detail}",
      refresh: "刷新",
      signIn: "登录",
      signOut: "退出登录",
      openBrowser: "打开浏览器",
      working: "进行中…",
      signinTitle: "登录",
      pasteLabel: "若浏览器无法重定向回本机，请把跳转后的 URL 或授权码粘贴到这里：",
      submit: "提交",
      abandon: "取消登录",
      signinCancelled: "已取消登录。",
      signinFailed: "登录失败：{detail}"
    };

    // Classify a wire/error message into an i18n key (+ params) or raw text.
    function classify(message) {
      var m = String(message || "");
      if (/no sign-in stored|not signed in|AUTH_MISSING|AUTH_INVALID/i.test(m)) return { key: "statusNotSignedIn" };
      if (/refresh failed|invalid_refresh_token|re-authenticate|sign in again/i.test(m)) return { key: "statusRefreshFailed", params: { detail: shorten(m) } };
      if (/unreachable|ECONNREFUSED|timeout|fetch failed|non-JSON/i.test(m)) return { key: "statusUnreachable", params: { detail: shorten(m) } };
      if (/HTTP \d{3}/.test(m)) return { key: "statusHttpError", params: { detail: m } };
      return { raw: m };
    }

    function shorten(m) {
      m = String(m || "");
      var cut = m.indexOf(" — ");
      if (cut > 0) m = m.slice(0, cut);
      return m.length > 140 ? m.slice(0, 140) + "…" : m;
    }

    function cssDot(color) {
      return {
        boxSizing: "border-box",
        width: 10,
        height: 10,
        borderRadius: "50%",
        flex: "none",
        display: "inline-block",
        background: color
      };
    }

    function relTime(t, at) {
      var diff = Date.now() - (at || 0);
      var s = Math.floor(diff / 1000);
      if (s < 5) return t("checkedJustNow");
      if (s < 60) return t("secondsAgo", { n: s });
      var m = Math.floor(s / 60);
      if (m < 60) return t("minutesAgo", { n: m });
      return t("hoursAgo", { n: Math.floor(m / 60) });
    }

    function statusText(t, status) {
      if (status.kind === "loading") return t("statusLoading");
      if (status.kind === "ok") return t("statusOk", { when: relTime(t, status.checkedAt) });
      if (status.raw) return status.raw;
      return t(status.key, status.params || {});
    }

    var rpcSeq = 0;
    function callRpc(endpoint, payload) {
      rpcSeq += 1;
      return fetch(RPC_BASE + "/" + endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "client-request",
          rpcId: "oauth-providers-" + String(rpcSeq),
          method: endpoint,
          payload: payload || {}
        })
      }).then(function (r) { return r.json(); }).then(function (body) {
        if (body && body.result) return body.result;
        return { ok: false, error: { message: "unexpected channel response" } };
      });
    }

    function Section(props) {
      var operations = props.operations;
      var t = props.t;

      var _p = React.useState([]);
      var providers = _p[0];
      var setProviders = _p[1];
      var _cat = React.useState(null);
      var catalog = _cat[0];
      var setCatalog = _cat[1];
      var aliveRef = React.useRef(true);

      function refreshChannelProviders() {
        return callRpc("providers").then(function (result) {
          if (result.ok && aliveRef.current) setProviders(result.value.providers || []);
          return result;
        }).catch(function () { return null; });
      }

      // Passive catalog: one call feeds every provider card.
      function checkCatalog() {
        return operations.modelCatalog().then(function (result) {
          if (aliveRef.current) setCatalog(result.ok ? result.value : { failures: [{ id: "", message: result.error ? result.error.message : "catalog failed" }] });
        }).catch(function () { /* surfaced per card by absence */ });
      }

      React.useEffect(function () {
        aliveRef.current = true;
        refreshChannelProviders().then(checkCatalog);
        return function () {
          aliveRef.current = false;
        };
      }, []);

      return React.createElement("div", { style: { padding: "0 24px 24px", maxWidth: 720 } },
        React.createElement("h2", { style: { margin: "0 0 4px", fontSize: 16, fontWeight: 600, lineHeight: "24px", color: "var(--dsw-alias-label-primary)" } }, t("title")),
        React.createElement("p", { style: { margin: "0 0 16px", fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-tertiary)" } }, t("intro")),
        providers.map(function (p) {
          return React.createElement(ProviderCard, {
            key: p.id,
            provider: p,
            catalog: catalog,
            operations: operations,
            t: t,
            refreshProviders: refreshChannelProviders,
            checkCatalog: checkCatalog
          });
        })
      );
    }

    function ProviderCard(props) {
      var provider = props.provider;
      var catalog = props.catalog;
      var operations = props.operations;
      var t = props.t;
      var id = provider.id;

      var _s = React.useState({ kind: "loading" });
      var status = _s[0];
      var setStatus = _s[1];
      var _m = React.useState([]);
      var models = _m[0];
      var setModels = _m[1];
      var _b = React.useState(false);
      var busy = _b[0];
      var setBusy = _b[1];
      var _au = React.useState(null);
      var auth = _au[0];
      var setAuth = _au[1];
      var _pa = React.useState("");
      var paste = _pa[0];
      var setPaste = _pa[1];
      var aliveRef = React.useRef(true);

      // Passive status from the shared catalog: groups carry models, failures carry reasons.
      function checkStatus() {
        setStatus({ kind: "loading" });
        return operations.modelCatalog().then(function (result) {
          if (!result.ok) {
            setStatus({ key: "statusModelsError", params: { detail: result.error ? result.error.message : "" } });
            return;
          }
          var groups = (result.value && result.value.groups) || [];
          var failures = (result.value && result.value.failures) || [];
          var group = groups.find(function (g) { return g.id === id; });
          var failure = failures.find(function (f) { return f.id === id; });
          if (group) {
            setModels(group.models || []);
            setStatus({ kind: "ok", checkedAt: Date.now() });
          } else if (failure) {
            setModels([]);
            var c = classify(failure.message);
            setStatus({ kind: "red", key: c.key, params: c.params, raw: c.raw });
          } else {
            setModels([]);
            setStatus({ kind: "yellow", key: "statusUnknown" });
          }
        }).catch(function (err) {
          setStatus({ key: "statusCheckError", params: { detail: err && err.message ? err.message : err } });
        });
      }

      // Active refresh: llm.discoverModels probes the sign-in and force-fetches models.
      function discover() {
        setBusy(true);
        setStatus({ kind: "loading" });
        return operations.discoverModels(provider.settingsNs, id).then(function (result) {
          if (result.ok) {
            setModels(result.value || []);
            setStatus({ kind: "ok", checkedAt: Date.now() });
          } else {
            var msg = result.error ? result.error.message : "discovery failed";
            setModels([]);
            var c = classify(msg);
            setStatus({ kind: "red", key: c.key, params: c.params, raw: c.raw });
          }
        }).catch(function (err) {
          var c = classify(err && err.message ? err.message : err);
          setStatus({ kind: "error", key: c.key, params: c.params, raw: c.raw });
        }).finally(function () {
          setBusy(false);
        });
      }

      // --- sign-in over the package's shared channel -------------------------

      function pollSignIn() {
        return callRpc("poll", { provider: id }).then(function (result) {
          if (!aliveRef.current) return;
          if (result.ok) {
            setAuth(result.value);
            var v = result.value || {};
            if (v.running) {
              setTimeout(pollSignIn, 1200);
              return;
            }
            if (v.done && v.done.status === "authorized") {
              discover();
              props.refreshProviders();
            }
          }
        }).catch(function () {
          if (aliveRef.current) setTimeout(pollSignIn, 2500);
        });
      }

      function startSignIn() {
        setPaste("");
        callRpc("begin", { provider: id }).then(function (result) {
          if (result.ok) {
            setAuth({ running: true });
            pollSignIn();
          } else {
            var msg = result.error ? result.error.message : "sign-in failed";
            var c = classify(msg);
            setStatus({ kind: "red", key: c.key, params: c.params, raw: c.raw });
          }
        }).catch(function (err) {
          setStatus({ key: "statusCheckError", params: { detail: err && err.message ? err.message : err } });
        });
      }

      function submitPaste() {
        var input = paste;
        callRpc("submit", { provider: id, input: input }).then(function () {
          setPaste("");
        });
      }

      function cancelSignIn() {
        callRpc("cancel", { provider: id }).then(function () { /* poll picks up the settlement */ });
      }

      function signOut() {
        callRpc("logout", { provider: id }).then(function () {
          setModels([]);
          setStatus({ key: "statusNotSignedIn" });
          props.refreshProviders();
        });
      }

      React.useEffect(function () {
        aliveRef.current = true;
        checkStatus();
        return function () {
          aliveRef.current = false;
        };
      }, []);

      var dotColor = status.kind === "ok" ? "var(--dsw-alias-state-success-primary)"
        : status.kind === "red" || status.kind === "error" ? "var(--dsw-alias-state-error-primary)"
        : "var(--dsw-alias-state-warn-label)";

      var running = !!(auth && auth.running);
      var notice = auth && auth.notice;
      var prompt = auth && auth.prompt;

      var refreshButton = running
        ? null
        : React.createElement("button", { type: "button", onClick: discover, disabled: busy, style: btnStyle(provider.signedIn || status.kind === "ok") }, busy ? t("working") : t("refresh"));
      var primaryButton;
      if (running) {
        primaryButton = React.createElement("button", { type: "button", disabled: true, style: btnStyle(true) }, t("working"));
      } else if (provider.signedIn || status.kind === "ok") {
        primaryButton = refreshButton;
      } else {
        primaryButton = React.createElement("button", { type: "button", onClick: startSignIn, style: btnStyle(true) }, t("signIn"));
      }

      return React.createElement("div", { style: { border: "1px solid var(--dsw-alias-border-l4)", borderRadius: 16, padding: "12px 14px", marginBottom: 14 } },
        React.createElement("h3", { style: { margin: "0 0 10px", fontSize: 14, fontWeight: 600, lineHeight: "22px", color: "var(--dsw-alias-label-primary)" } }, provider.label || id),

        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12 } },
          React.createElement("span", { style: cssDot(dotColor) }),
          React.createElement("span", { style: { flex: 1, fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-secondary)" } }, statusText(t, status)),
          provider.signedIn ? React.createElement("button", { type: "button", onClick: signOut, style: btnStyle(false) }, t("signOut")) : null,
          primaryButton === refreshButton ? null : refreshButton,
          primaryButton
        ),

        running ? React.createElement("div", { style: { border: "1px solid var(--dsw-alias-border-l3)", borderRadius: 10, padding: "10px 12px", marginBottom: 12 } },
          React.createElement("div", { style: { fontSize: 13, fontWeight: 600, lineHeight: "20px", marginBottom: 6, color: "var(--dsw-alias-label-primary)" } }, t("signinTitle")),
          notice ? React.createElement("div", { style: { fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-secondary)", marginBottom: 6 } },
            notice.message || "",
            notice.url ? React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 6 } },
              React.createElement("a", { href: notice.url, target: "_blank", rel: "noreferrer", style: { fontSize: 12, color: "var(--dsw-alias-brand-primary)", wordBreak: "break-all", flex: 1 } }, notice.url),
              React.createElement("button", { type: "button", onClick: function () { window.open(notice.url, "_blank", "noopener"); }, style: btnStyle(true) }, t("openBrowser"))
            ) : null
          ) : null,
          prompt ? React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 6 } },
            React.createElement("span", { style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" } }, t("pasteLabel")),
            React.createElement("div", { style: { display: "flex", gap: 8 } },
              React.createElement("input", { type: "text", value: paste, placeholder: prompt.placeholder || "", onChange: function (e) { setPaste(e.target.value); }, style: inputStyle(), onKeyDown: function (e) { if (e.key === "Enter") submitPaste(); } }),
              React.createElement("button", { type: "button", onClick: submitPaste, style: btnStyle(true) }, t("submit"))
            )
          ) : null,
          React.createElement("div", { style: { marginTop: 10 } },
            React.createElement("button", { type: "button", onClick: cancelSignIn, style: btnStyle(false) }, t("abandon"))
          )
        ) : null,

        React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 0 } },
          models.map(function (m) {
            return React.createElement("span", {
              key: m.id,
              style: { border: "1px solid var(--dsw-alias-border-l3)", borderRadius: 6, padding: "2px 8px", fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" }
            }, m.id + (m.contextWindow ? " · " + m.contextWindow : ""));
          })
        ),

      );
    }

    function inputStyle() {
      return {
        boxSizing: "border-box",
        border: "1px solid var(--dsw-alias-border-l2)",
        width: "100%",
        height: 32,
        background: "var(--dsw-alias-bg-layer-1)",
        color: "var(--dsw-alias-label-primary)",
        borderRadius: 8,
        padding: "0 10px",
        fontSize: 14,
        lineHeight: "22px"
      };
    }

    function btnStyle(primary) {
      return {
        boxSizing: "border-box",
        height: 28,
        border: primary ? "none" : "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 14,
        padding: "0 12px",
        fontSize: 12,
        lineHeight: "18px",
        cursor: "pointer",
        background: primary ? "var(--dsw-alias-button-primary-fill)" : "transparent",
        color: primary ? "var(--dsw-alias-label-primary-foreground)" : "var(--dsw-alias-label-primary)"
      };
    }

    function apply(ctx) {
      ctx.effect(function () { return ctx.locale.register(LOCALE_NS, { zh: zh, en: en }); }, "dsh-oauth-providers: locale");
      var t = ctx.locale.bind(LOCALE_NS);
      // Host operations stay in the apply world; the section and its cards only
      // receive these bound callbacks plus the localized string binder.
      var operations = {
        modelCatalog: function () { return ctx.remote.session.modelCatalog(); },
        discoverModels: function (ns, provider) { return ctx.remote.llm.discoverModels(ns, { provider: provider }); }
      };
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "dsh-oauth-providers",
          order: 20,
          label: function () { return t("nav"); },
          inject: function () {
            return { operations: operations, t: t };
          }
        }, Section);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale", "remote", "remote.llm", "remote.session"];
    return module.exports;
  }
});
