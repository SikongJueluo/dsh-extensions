// Client half of dsh-handoff: the model picker shown when /handoff asks which
// model the fresh session should run on. Plain JavaScript (no JSX), evaluated
// by the DSH client module loader.
//
// Registers one `shell.overlay` entry — the frame-wide floating layer, so the
// picker is a real modal — and talks to the host half over this package's
// channel (`/dsh-handoff`): poll for a pending pick, submit the chosen route
// or cancel. The catalog comes from the same Client Remote the /model popup
// reads, so provider groups, model display names, and descriptions match.
window.__ModuleLoader__.load({
  id: "dsh-handoff",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    var RPC_BASE = "/dsh-handoff";
    var POLL_MS = 1500;

    var rpcSeq = 0;
    function callRpc(endpoint, payload) {
      rpcSeq += 1;
      return fetch(RPC_BASE + "/" + endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "client-request",
          rpcId: "handoff-" + String(rpcSeq),
          method: endpoint,
          payload: payload || {}
        })
      }).then(function (r) { return r.json(); }).then(function (body) {
        if (body && body.result) return body.result;
        return { ok: false, message: "unexpected channel response" };
      });
    }

    var INHERIT_LABEL = "继承当前会话";
    var DEFAULT_LABEL = "全局默认";

    // --- styles (theme-token driven, so light/dark both work) ---
    var backdrop = {
      position: "fixed", inset: "0", zIndex: 40,
      background: "rgba(0, 0, 0, 0.32)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: "24px"
    };
    var card = {
      width: "min(560px, 92vw)", maxHeight: "72vh",
      display: "flex", flexDirection: "column",
      background: "var(--dsw-specific-input-major, var(--dsw-alias-bg-module-platform, #1f1f22))",
      color: "var(--dsw-alias-label-primary, #e8e8ea)",
      border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12))",
      borderRadius: "20px", boxShadow: "var(--dsw-elevation-panel, 0 12px 32px rgba(0,0,0,.35))",
      overflow: "hidden"
    };
    var header = { padding: "18px 20px 10px", display: "flex", flexDirection: "column", gap: "4px" };
    var title = { fontSize: "16px", fontWeight: 500, lineHeight: "22px" };
    var subtitle = {
      fontSize: "12px", lineHeight: "18px",
      color: "var(--dsw-alias-label-tertiary, #9a9aa2)",
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
    };
    var search = {
      margin: "0 20px 8px", padding: "8px 12px",
      font: "inherit", fontSize: "14px",
      color: "var(--dsw-alias-label-primary, #e8e8ea)",
      background: "var(--dsw-alias-bg-module-platform, rgba(255,255,255,.04))",
      border: "1px solid var(--dsw-alias-border-l4, rgba(255,255,255,.16))",
      borderRadius: "10px", outline: "none"
    };
    var body = { overflowY: "auto", padding: "4px 12px 12px", flex: "1 1 auto", minHeight: "0" };
    var groupTitle = {
      padding: "10px 8px 4px", fontSize: "11px", lineHeight: "16px", textTransform: "uppercase",
      letterSpacing: "0.04em", color: "var(--dsw-alias-label-tertiary, #9a9aa2)"
    };
    var row = {
      display: "flex", flexDirection: "column", gap: "2px",
      width: "100%", textAlign: "left", cursor: "pointer",
      padding: "8px 10px", borderRadius: "12px",
      background: "transparent", border: "1px solid transparent",
      color: "inherit", font: "inherit"
    };
    var rowLabel = { fontSize: "14px", lineHeight: "22px", fontWeight: 500 };
    var rowLine = { display: "flex", alignItems: "center", gap: "6px", minWidth: "0" };
    var badge = {
      flexShrink: "0", fontSize: "11px", lineHeight: "18px", fontWeight: 600,
      padding: "0 6px", borderRadius: "6px",
      color: "var(--dsw-alias-button-info-fill, #8ab4ff)",
      background: "var(--dsw-specific-sidebar-nav-item-active-accent, rgba(138,180,255,.16))"
    };
    var rowDesc = {
      fontSize: "12px", lineHeight: "18px",
      color: "var(--dsw-alias-label-tertiary, #9a9aa2)",
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
    };
    var divider = { height: "1px", background: "var(--dsw-alias-border-l2, rgba(255,255,255,.12))", margin: "8px 8px" };
    var footer = { display: "flex", justifyContent: "flex-end", gap: "8px", padding: "10px 20px 16px" };
    var button = {
      font: "inherit", fontSize: "13px", padding: "7px 14px", borderRadius: "10px", cursor: "pointer",
      color: "var(--dsw-alias-label-primary, #e8e8ea)",
      background: "transparent",
      border: "1px solid var(--dsw-alias-border-l4, rgba(255,255,255,.16))"
    };
    var empty = {
      padding: "12px 10px", fontSize: "13px",
      color: "var(--dsw-alias-label-tertiary, #9a9aa2)"
    };
    var errorLine = {
      padding: "0 20px", fontSize: "12px",
      color: "var(--dsw-alias-state-error-primary, #f2727a)"
    };

    function hoverStyle(active) {
      return active ? { background: "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))" } : null;
    }

    /** One clickable entry, optionally carrying a small badge beside its label. */
    function Entry(props) {
      var hovered = React.useState(false);
      var isHovered = hovered[0];
      var setHovered = hovered[1];
      var style = Object.assign({}, row, hoverStyle(isHovered) || {});
      return React.createElement("button", {
        type: "button",
        style: style,
        disabled: props.busy,
        onMouseEnter: function () { setHovered(true); },
        onMouseLeave: function () { setHovered(false); },
        onClick: props.onPick
      }, [
        React.createElement("span", { key: "line", style: rowLine }, [
          React.createElement("span", { key: "label", style: rowLabel }, props.label),
          props.badge
            ? React.createElement("span", { key: "badge", style: badge }, props.badge)
            : null
        ]),
        props.description
          ? React.createElement("span", { key: "desc", style: rowDesc }, props.description)
          : null
      ]);
    }

    /** The picker itself, rendered only while a pick is pending. */
    function Picker(props) {
      var request = props.request;
      var operations = props.operations;

      var catalogState = React.useState(null);
      var catalog = catalogState[0];
      var setCatalog = catalogState[1];
      var queryState = React.useState("");
      var query = queryState[0];
      var setQuery = queryState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      // Non-null while the second step (reasoning effort) is showing.
      var effortState = React.useState(null);
      var effortFor = effortState[0];
      var setEffortFor = effortState[1];

      React.useEffect(function () {
        if (request === null) return undefined;
        setQuery("");
        setError(null);
        setEffortFor(null);
        var alive = true;
        // `ctx.remote.*` answers with the connection result envelope
        // ({ok:true, value} | {ok:false, error}); the catalog is inside `value`.
        operations.modelCatalog().then(function (result) {
          if (!alive) return;
          if (result && result.ok === true) {
            setCatalog(result.value);
            return;
          }
          var failure = result && result.error ? result.error : null;
          setError(failure && failure.message ? failure.message : "模型目录加载失败");
        }).catch(function (err) {
          if (alive) setError(String(err && err.message ? err.message : err));
        });
        return function () { alive = false; };
      }, [request === null ? "" : request.id]);

      function submit(choice) {
        if (busy) return;
        setBusy(true);
        operations.choose(request.id, choice).then(function (result) {
          if (result && result.ok) {
            props.onSettled();
          } else {
            setBusy(false);
            setError(result && result.message ? result.message : "选择提交失败");
          }
        }).catch(function (err) {
          setBusy(false);
          setError(String(err && err.message ? err.message : err));
        });
      }

      function cancel() {
        if (busy) return;
        setBusy(true);
        operations.cancel(request.id).then(function () { props.onSettled(); }).catch(function () { props.onSettled(); });
      }

      React.useEffect(function () {
        function onKey(event) {
          if (event.key !== "Escape") return;
          // Escape steps back out of the effort step, then cancels.
          if (effortFor !== null) setEffortFor(null);
          else cancel();
        }
        window.addEventListener("keydown", onKey);
        return function () { window.removeEventListener("keydown", onKey); };
      }, [request.id, busy, effortFor === null ? "" : effortFor.model]);

      var needle = query.trim().toLowerCase();
      var groups = [];
      var allGroups = catalog && catalog.groups ? catalog.groups : [];
      for (var i = 0; i < allGroups.length; i += 1) {
        var group = allGroups[i];
        var kept = [];
        for (var j = 0; j < group.models.length; j += 1) {
          var model = group.models[j];
          var haystack = (model.name + " " + model.id + " " + (model.description || "") + " " + group.name).toLowerCase();
          if (needle.length === 0 || haystack.indexOf(needle) >= 0) kept.push(model);
        }
        if (kept.length > 0) groups.push({ id: group.id, name: group.name, models: kept });
      }
      // Providers whose catalog lookup failed are reported, never silently absent.
      var failures = (catalog && catalog.failures ? catalog.failures : []).filter(function (failure) {
        return needle.length === 0 || (failure.name + " " + failure.id + " " + failure.message).toLowerCase().indexOf(needle) >= 0;
      });

      /** Name a base option's route as the full catalog labels it, else as provider/model. */
      function routeText(route, fallbackText) {
        if (!route) return fallbackText;
        for (var g = 0; g < allGroups.length; g += 1) {
          if (allGroups[g].id !== route.provider) continue;
          for (var m = 0; m < allGroups[g].models.length; m += 1) {
            if (allGroups[g].models[m].id === route.model) {
              return allGroups[g].models[m].name + " · " + route.provider + "/" + route.model;
            }
          }
        }
        return route.provider + "/" + route.model;
      }

      /** One model row: pick it, or step into its reasoning-effort choices. */
      function chooseModel(provider, model) {
        var reasoning = model.reasoning;
        var efforts = reasoning && reasoning.efforts ? reasoning.efforts : [];
        if (efforts.length === 0) {
          submit({ kind: "model", provider: provider, model: model.id });
          return;
        }
        // Picking the origin's own route preselects the effort it already runs.
        var inherited = request.inherited;
        var preferred = inherited && inherited.provider === provider && inherited.model === model.id
          ? inherited.reasoningEffort
          : undefined;
        setEffortFor({
          provider: provider,
          model: model.id,
          name: model.name,
          efforts: efforts,
          defaultEffort: reasoning.defaultEffort,
          preferred: preferred
        });
      }

      // Second step: the model advertises reasoning efforts, so ask which one.
      if (effortFor !== null) {
        var effortRows = effortFor.efforts.map(function (effort) {
          var marker = effort.id === effortFor.preferred
            ? "当前会话"
            : effort.id === effortFor.defaultEffort
              ? "默认"
              : undefined;
          return React.createElement(Entry, {
            key: "e:" + effort.id,
            label: effort.name,
            description: effort.description || undefined,
            badge: marker,
            busy: busy,
            onPick: function () {
              submit({
                kind: "model",
                provider: effortFor.provider,
                model: effortFor.model,
                reasoningEffort: effort.id
              });
            }
          });
        });
        return React.createElement("div", {
          style: backdrop,
          onMouseDown: function (event) { if (event.target === event.currentTarget) cancel(); }
        }, React.createElement("div", { style: card }, [
          React.createElement("div", { key: "header", style: header }, [
            React.createElement("div", { key: "title", style: title }, effortFor.name + " · 思考强度"),
            React.createElement("div", { key: "task", style: subtitle }, "选择新会话的 reasoning effort")
          ]),
          React.createElement("div", { key: "body", style: body }, effortRows),
          error !== null
            ? React.createElement("div", { key: "error", style: errorLine }, error)
            : null,
          React.createElement("div", { key: "footer", style: footer }, [
            React.createElement("button", {
              key: "back", type: "button", style: button, disabled: busy,
              onClick: function () { setEffortFor(null); }
            }, "返回"),
            React.createElement("button", {
              key: "cancel", type: "button", style: button, disabled: busy, onClick: cancel
            }, "取消")
          ])
        ]));
      }

      var children = [
        React.createElement("div", { key: "header", style: header }, [
          React.createElement("div", { key: "title", style: title }, "新会话使用哪个模型？"),
          React.createElement("div", { key: "task", style: subtitle }, request.task)
        ]),
        React.createElement("input", {
          key: "search",
          style: search,
          value: query,
          placeholder: "搜索模型 / 厂商…",
          autoFocus: true,
          onChange: function (event) { setQuery(event.target.value); }
        }),
        React.createElement("div", { key: "body", style: body }, [
          React.createElement(Entry, {
            key: "inherit",
            label: INHERIT_LABEL,
            description: routeText(request.inherited, "沿用本会话的 preset 与模型"),
            busy: busy,
            onPick: function () { submit({ kind: "inherit" }); }
          }),
          React.createElement(Entry, {
            key: "default",
            label: DEFAULT_LABEL,
            description: routeText(request.fallback, "默认 preset + 全局默认模型"),
            busy: busy,
            onPick: function () { submit({ kind: "default" }); }
          }),
          React.createElement("div", { key: "divider", style: divider })
        ].concat(
          catalog === null && error === null
            ? [React.createElement("div", { key: "loading", style: empty }, "正在加载模型目录…")]
            : groups.length === 0 && failures.length === 0
              ? [React.createElement("div", { key: "none", style: empty }, needle.length > 0 ? "没有匹配的模型" : "没有可用的模型")]
              : groups.map(function (group) {
                  return React.createElement("div", { key: "g:" + group.id }, [
                    React.createElement("div", { key: "gt", style: groupTitle }, group.name)
                  ].concat(group.models.map(function (model) {
                    var description = [];
                    if (model.name !== model.id) description.push(model.id);
                    if (model.description) description.push(model.description);
                    if (model.reasoning && model.reasoning.defaultEffort) {
                      var defaultName = model.reasoning.defaultEffort;
                      for (var e = 0; e < model.reasoning.efforts.length; e += 1) {
                        if (model.reasoning.efforts[e].id === model.reasoning.defaultEffort) {
                          defaultName = model.reasoning.efforts[e].name;
                          break;
                        }
                      }
                      description.push("默认强度 " + defaultName);
                    }
                    return React.createElement(Entry, {
                      key: "m:" + group.id + "/" + model.id,
                      label: model.name,
                      description: description.join(" · ") || undefined,
                      busy: busy,
                      onPick: function () { chooseModel(group.id, model); }
                    });
                  })));
                }).concat(
                  failures.length === 0
                    ? []
                    : [React.createElement("div", { key: "failures" }, [
                        React.createElement("div", { key: "fht", style: groupTitle }, "不可用")
                      ].concat(failures.map(function (failure) {
                        return React.createElement("div", {
                          key: "f:" + failure.id,
                          style: { padding: "8px 10px", display: "flex", flexDirection: "column", gap: "2px" }
                        }, [
                          React.createElement("span", { key: "n", style: rowLabel }, failure.name || failure.id),
                          React.createElement("span", { key: "m", style: rowDesc }, failure.message)
                        ]);
                      })))]
                )
        )),
        error !== null
          ? React.createElement("div", { key: "error", style: errorLine }, error)
          : null,
        React.createElement("div", { key: "footer", style: footer },
          React.createElement("button", { type: "button", style: button, disabled: busy, onClick: cancel }, "取消")
        )
      ];

      return React.createElement("div", {
        style: backdrop,
        onMouseDown: function (event) { if (event.target === event.currentTarget) cancel(); }
      }, React.createElement("div", { style: card }, children));
    }

    /** Root overlay: polls the host channel and mounts the picker on demand. */
    function Overlay(props) {
      var operations = props.operations;
      var requestState = React.useState(null);
      var request = requestState[0];
      var setRequest = requestState[1];

      React.useEffect(function () {
        var alive = true;
        function tick() {
          operations.pending().then(function (result) {
            if (!alive) return;
            var list = result && result.requests ? result.requests : [];
            setRequest(list.length > 0 ? list[0] : null);
          }).catch(function () { /* offline or channel absent: keep the previous state */ });
        }
        tick();
        var timer = window.setInterval(tick, POLL_MS);
        return function () { alive = false; window.clearInterval(timer); };
      }, []);

      if (request === null) return null;
      return React.createElement(Picker, {
        request: request,
        operations: operations,
        onSettled: function () { setRequest(null); }
      });
    }

    function apply(ctx) {
      var operations = {
        pending: function () { return callRpc("pending", {}); },
        choose: function (requestId, choice) { return callRpc("choose", { requestId: requestId, choice: choice }); },
        cancel: function (requestId) { return callRpc("cancel", { requestId: requestId }); },
        modelCatalog: function () { return ctx.remote.session.modelCatalog(); }
      };
      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register({
          name: "shell.overlay",
          id: "dsh-handoff-picker",
          order: 50,
          inject: function () { return { operations: operations }; }
        }, Overlay);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote", "remote.session"];
    return module.exports;
  }
});
