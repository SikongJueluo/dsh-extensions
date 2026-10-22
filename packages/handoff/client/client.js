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
    var ORIGIN_LABEL = "原工作区";
    var ORIGIN_BADGE = "当前";
    // Retry requests carry the previous attempt's picks; matching rows wear
    // this badge so a retry starts one click from where it left off.
    var PREV_BADGE = "上次";
    // The workspace selector selects rows instead of submitting; the
    // selected row wears this badge until the card submits.
    var SELECTED_BADGE = "已选";
    // Flag-decided fields display with this badge and no 更改 button, so the
    // summary can never contradict what will actually run.
    var FLAG_BADGE = "命令指定";
    var REVIEW_LABEL = "执行完成后自动交回当前会话审核";

    // Touch-primary devices (phones): hover feedback and autofocus are
    // desktop enhancements; on them a tap-fired mouseenter sticks and the
    // autofocus keyboard covers the list, so both stay off.
    var COARSE = typeof window.matchMedia === "function"
      && window.matchMedia("(pointer: coarse)").matches;

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
      font: "inherit",
      // 16px keeps iOS Safari from zooming the page when the field focuses.
      fontSize: "16px",
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
      display: "flex", flexDirection: "column", gap: "2px", minHeight: 44, justifyContent: "center",
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
      font: "inherit", fontSize: "13px", minHeight: 44, padding: "8px 14px", borderRadius: "10px", cursor: "pointer",
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

    /** One clickable entry, optionally carrying a small badge beside its label.
     * `muted` renders an unselectable row (e.g. a workspace whose directory
     * is gone) without hiding the reason from the operator. */
    function Entry(props) {
      var hovered = React.useState(false);
      var isHovered = hovered[0];
      var setHovered = hovered[1];
      var style = Object.assign({}, row, hoverStyle(isHovered) || {});
      if (props.muted) style = Object.assign(style, { opacity: 0.5, cursor: "default" });
      return React.createElement("button", {
        type: "button",
        style: style,
        disabled: props.busy || props.muted === true,
        onMouseEnter: COARSE ? undefined : function () { setHovered(true); },
        onMouseLeave: COARSE ? undefined : function () { setHovered(false); },
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

    /** The configuration card, rendered only while a pick is pending.
     * ONE card, not a wizard: every field shows its effective value (defaults
     * pre-filled — inherit model, origin workspace), 更改 expands that one
     * field's selector in place, the auto-review block is always visible in
     * its own section, and only the fixed 开始交接 button submits. Flag-fixed
     * fields display with a 命令指定 badge and no 更改 button, so the summary
     * can never contradict what will actually run. */
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
      // The field whose selector is expanded: null = the summary card.
      var sectionState = React.useState(null);
      var section = sectionState[0];
      var setSection = sectionState[1];
      // The model choice in force (defaults to inherit / the retry's pick).
      var choiceState = React.useState(null);
      var choice = choiceState[0];
      var setChoice = choiceState[1];
      // The selected workspace id (undefined = origin).
      var wsPickState = React.useState(undefined);
      var wsPick = wsPickState[0];
      var setWsPick = wsPickState[1];
      // Auto-review verdict: offered toggle or flag-fixed display.
      var reviewOffer = request.review || null;
      var reviewFixed = !!(reviewOffer && reviewOffer.fixed === true);
      var reviewState = React.useState({
        enabled: !!(reviewOffer && reviewOffer.enabled === true),
        rounds: reviewOffer ? reviewOffer.defaultRounds : 5
      });
      var review = reviewState[0];
      var setReview = reviewState[1];

      var modelFixed = request.modelFixed === true;
      var fixedModel = request.fixedModel || null;
      var fixedWorkspace = request.fixedWorkspace || null;
      var previous = request.previous || null;
      var prevChoice = previous ? previous.choice : null;
      var prevWorkspace = previous ? previous.workspaceId : undefined;

      var effectiveChoice = choice
        || (prevChoice && (prevChoice.kind === "model" || prevChoice.kind === "default") ? prevChoice : null)
        || { kind: "inherit" };

      function needsWorkspace() {
        return request.pickWorkspace === true
          && request.workspaces && request.workspaces.length > 0;
      }

      /** The ONE effective workspace verdict, shared by the summary row AND
       * the submit payload: this pick → the retry's previous pick (when it is
       * still in the roster) → origin. Display and payload must never
       * disagree — a card that shows "Other" must not submit "origin". */
      function effectiveWorkspace() {
        if (wsPick !== undefined) return wsPick;
        if (prevWorkspace !== undefined && (prevWorkspace === "origin"
          || (request.workspaces || []).some(function (w) { return w.id === prevWorkspace; }))) {
          return prevWorkspace;
        }
        return "origin";
      }

      React.useEffect(function () {
        if (request === null) return undefined;
        setQuery("");
        setError(null);
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

      /** Send the final verdict to the host: model choice, workspace pick, review toggle. */
      function finalize() {
        if (busy) return;
        setBusy(true);
        var payload = Object.assign({}, modelFixed ? { kind: "inherit" } : effectiveChoice);
        if (needsWorkspace()) payload.workspace = effectiveWorkspace();
        if (reviewOffer) payload.review = { enabled: review.enabled, rounds: review.rounds };
        operations.choose(request.id, payload).then(function (result) {
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
          // Escape collapses an expanded selector first; at the card it cancels.
          if (section !== null) setSection(null);
          else cancel();
        }
        window.addEventListener("keydown", onKey);
        return function () { window.removeEventListener("keydown", onKey); };
      }, [request.id, busy, section]);

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

      /** The catalog's entry for one route, when it advertises it. */
      function catalogModel(provider, model) {
        for (var g = 0; g < allGroups.length; g += 1) {
          if (allGroups[g].id !== provider) continue;
          for (var m = 0; m < allGroups[g].models.length; m += 1) {
            if (allGroups[g].models[m].id === model) return allGroups[g].models[m];
          }
        }
        return null;
      }

      /** The catalog's display name for one reasoning effort, else the raw id. */
      function effortText(provider, model, effortId) {
        var entry = catalogModel(provider, model);
        var efforts = entry && entry.reasoning && entry.reasoning.efforts ? entry.reasoning.efforts : [];
        for (var e = 0; e < efforts.length; e += 1) {
          if (efforts[e].id === effortId) return efforts[e].name;
        }
        return effortId;
      }

      /** Name a route as the full catalog labels it, effort included. */
      function routeText(route, fallbackText) {
        if (!route) return fallbackText;
        var entry = catalogModel(route.provider, route.model);
        var parts = [];
        if (entry) parts.push(entry.name);
        parts.push(route.provider + "/" + route.model);
        if (route.reasoningEffort) parts.push("强度 " + effortText(route.provider, route.model, route.reasoningEffort));
        return parts.join(" · ");
      }

      /** True when a retry's previous choice points at this route. */
      function isPrevModel(provider, model) {
        return !!(prevChoice && prevChoice.kind === "model"
          && prevChoice.provider === provider && prevChoice.model === model);
      }

      /** The route the effort section edits, when its model advertises efforts. */
      function effortRoute() {
        if (modelFixed) return fixedModel;
        if (effectiveChoice.kind === "model") return effectiveChoice;
        if (effectiveChoice.kind === "inherit") return request.inherited || null;
        return request.fallback || null;
      }

      /** Adopt an effort for the current model choice. Inherit/default picks
       * become explicit model choices: an inherited route with a changed
       * effort is exactly that route with the effort spelled out. */
      function pickEffort(effortId) {
        var route = effortRoute();
        if (!route) { setSection(null); return; }
        setChoice({
          kind: "model",
          provider: route.provider,
          model: route.model,
          reasoningEffort: effortId
        });
        setSection(null);
      }

      var cardFooter = React.createElement("div", { key: "footer", style: footer },
        [
          React.createElement("button", {
            key: "cancel", type: "button", style: button, disabled: busy, onClick: cancel
          }, "取消"),
          React.createElement("button", {
            key: "go", type: "button",
            style: Object.assign({}, button, {
              background: "var(--dsw-alias-accent-major, #4c6ef5)",
              color: "#fff", border: "1px solid transparent"
            }),
            disabled: busy,
            onClick: finalize
          }, "开始交接")
        ]);

      var errorLineEl = error !== null
        ? React.createElement("div", { key: "error", style: errorLine }, error)
        : null;

      // ── expanded selectors (one field at a time, inside the same card) ────
      if (section === "model") {
        return React.createElement("div", {
          style: backdrop,
          onClick: function (event) { if (event.target === event.currentTarget) cancel(); }
        }, React.createElement("div", { style: card }, [
          React.createElement("div", { key: "header", style: header }, [
            React.createElement("div", { key: "title", style: title }, "新会话使用哪个模型？"),
            React.createElement("div", { key: "task", style: subtitle }, request.task)
          ]),
          React.createElement("input", {
            key: "search",
            style: search,
            value: query,
            placeholder: "搜索模型 / 厂商…",
            autoFocus: !COARSE,
            onChange: function (event) { setQuery(event.target.value); }
          }),
          React.createElement("div", { key: "body", style: body }, [
            React.createElement(Entry, {
              key: "inherit",
              label: INHERIT_LABEL,
              description: routeText(request.inherited, "沿用本会话的 preset 与模型"),
              badge: prevChoice && prevChoice.kind === "inherit" ? PREV_BADGE : undefined,
              busy: busy,
              onPick: function () { setChoice({ kind: "inherit" }); setSection(null); }
            }),
            React.createElement(Entry, {
              key: "default",
              label: DEFAULT_LABEL,
              description: routeText(request.fallback, "默认 preset + 全局默认模型"),
              badge: prevChoice && prevChoice.kind === "default" ? PREV_BADGE : undefined,
              busy: busy,
              onPick: function () { setChoice({ kind: "default" }); setSection(null); }
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
                        badge: isPrevModel(group.id, model.id) ? PREV_BADGE : undefined,
                        busy: busy,
                        onPick: function () {
                          // A model without efforts commits directly; one with
                          // efforts keeps its default until 更改 强度.
                          setChoice({ kind: "model", provider: group.id, model: model.id });
                          setSection(null);
                        }
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
          errorLineEl,
          React.createElement("div", { key: "footer", style: footer },
            React.createElement("button", {
              key: "back", type: "button", style: button, disabled: busy,
              onClick: function () { setSection(null); }
            }, "返回配置"))
        ]));
      }

      if (section === "effort") {
        var effortRouteNow = effortRoute();
        var effortEntry = effortRouteNow ? catalogModel(effortRouteNow.provider, effortRouteNow.model) : null;
        var efforts = effortEntry && effortEntry.reasoning && effortEntry.reasoning.efforts ? effortEntry.reasoning.efforts : [];
        var currentEffort = effortRouteNow && effortRouteNow.reasoningEffort;
        var effortRows = efforts.map(function (effort) {
          var marker = effort.id === currentEffort ? "当前" : effort.id === (effortEntry.reasoning.defaultEffort) ? "默认" : undefined;
          return React.createElement(Entry, {
            key: "e:" + effort.id,
            label: effort.name,
            description: effort.description || undefined,
            badge: marker,
            busy: busy,
            onPick: function () { pickEffort(effort.id); }
          });
        });
        return React.createElement("div", {
          style: backdrop,
          onClick: function (event) { if (event.target === event.currentTarget) cancel(); }
        }, React.createElement("div", { style: card }, [
          React.createElement("div", { key: "header", style: header }, [
            React.createElement("div", { key: "title", style: title }, "思考强度"),
            React.createElement("div", { key: "task", style: subtitle }, request.task)
          ]),
          React.createElement("div", { key: "body", style: body }, effortRows),
          errorLineEl,
          React.createElement("div", { key: "footer", style: footer },
            React.createElement("button", {
              key: "back", type: "button", style: button, disabled: busy,
              onClick: function () { setSection(null); }
            }, "返回配置"))
        ]));
      }

      if (section === "workspace") {
        var wsList = request.workspaces || [];
        var wsNeedle = query.trim().toLowerCase();
        var wsFiltered = wsList.filter(function (w) {
          return wsNeedle.length === 0 || (w.title + " " + w.path).toLowerCase().indexOf(wsNeedle) >= 0;
        });
        var wsTitleCounts = {};
        wsList.forEach(function (w) { wsTitleCounts[w.title] = (wsTitleCounts[w.title] || 0) + 1; });
        var effectiveWs = effectiveWorkspace();
        var wsRows = [
          React.createElement(Entry, {
            key: "origin",
            label: ORIGIN_LABEL,
            badge: effectiveWs === "origin" ? SELECTED_BADGE : (prevWorkspace === "origin" ? PREV_BADGE : ORIGIN_BADGE),
            description: request.origin ? request.origin.path : undefined,
            busy: busy,
            onPick: function () { setWsPick("origin"); setSection(null); }
          }),
          React.createElement("div", { key: "divider", style: divider })
        ].concat(
          wsFiltered.length === 0
            ? [React.createElement("div", {
                key: "none", style: empty
              }, wsNeedle.length > 0 ? "没有匹配的工作区" : "没有其他已注册的工作区")]
            : wsFiltered.map(function (w) {
                var tail = w.path.split("/").filter(Boolean).slice(-2).join("/");
                var label = (wsTitleCounts[w.title] || 0) > 1 ? w.title + " (" + tail + ")" : w.title;
                return React.createElement(Entry, {
                  key: "w:" + w.id,
                  label: label,
                  description: w.missing ? w.path + " · 目录不存在" : w.path,
                  muted: w.missing === true,
                  badge: effectiveWs === w.id ? SELECTED_BADGE : (w.id === prevWorkspace ? PREV_BADGE : undefined),
                  busy: busy,
                  onPick: function () { if (w.missing !== true) { setWsPick(w.id); setSection(null); } }
                });
              })
        );
        return React.createElement("div", {
          style: backdrop,
          onClick: function (event) { if (event.target === event.currentTarget) cancel(); }
        }, React.createElement("div", { style: card }, [
          React.createElement("div", { key: "header", style: header }, [
            React.createElement("div", { key: "title", style: title }, "新会话开在哪个工作区？"),
            React.createElement("div", { key: "task", style: subtitle }, request.task)
          ]),
          React.createElement("input", {
            key: "search",
            style: search,
            value: query,
            placeholder: "搜索工作区 / 路径…",
            autoFocus: !COARSE,
            onChange: function (event) { setQuery(event.target.value); }
          }),
          React.createElement("div", { key: "body", style: body }, wsRows),
          errorLineEl,
          React.createElement("div", { key: "footer", style: footer },
            React.createElement("button", {
              key: "back", type: "button", style: button, disabled: busy,
              onClick: function () { setSection(null); }
            }, "返回配置"))
        ]));
      }

      // ── the configuration card itself ─────────────────────────────────────
      var modelValue = modelFixed
        ? routeText(fixedModel, "由 --model 指定")
        : effectiveChoice.kind === "model"
          ? routeText(effectiveChoice, effectiveChoice.provider + "/" + effectiveChoice.model)
          : effectiveChoice.kind === "default"
            ? routeText(request.fallback, "默认 preset + 全局默认模型")
            : routeText(request.inherited, "沿用本会话的 preset 与模型");
      var modelLabel = modelFixed
        ? FLAG_BADGE
        : effectiveChoice.kind === "model" ? "已选模型"
          : effectiveChoice.kind === "default" ? DEFAULT_LABEL : INHERIT_LABEL;

      var effortRouteCard = effortRoute();
      var effortEntryCard = effortRouteCard ? catalogModel(effortRouteCard.provider, effortRouteCard.model) : null;
      var hasEfforts = !!(effortEntryCard && effortEntryCard.reasoning && effortEntryCard.reasoning.efforts
        && effortEntryCard.reasoning.efforts.length > 0);
      var effortValue = hasEfforts
        ? (effortRouteCard && effortRouteCard.reasoningEffort
            ? "强度 " + effortText(effortRouteCard.provider, effortRouteCard.model, effortRouteCard.reasoningEffort)
            : "模型默认强度")
        : null;

      var wsValue;
      var wsChangeable;
      if (fixedWorkspace) {
        wsValue = fixedWorkspace.title + "（" + fixedWorkspace.path + "）";
        wsChangeable = false;
      } else if (needsWorkspace()) {
        var effectiveCard = effectiveWorkspace();
        var wsListCard = request.workspaces || [];
        var pickedCard = wsListCard.find(function (w) { return w.id === effectiveCard; });
        wsValue = pickedCard
          ? pickedCard.title + "（" + pickedCard.path + "）"
          : "原工作区（" + (request.origin ? request.origin.path : "") + "）";
        wsChangeable = true;
      } else {
        wsValue = "原工作区（" + (request.origin ? request.origin.path : "") + "）";
        wsChangeable = false;
      }

      /** One summary row: label, value (may carry a badge), optional 更改.
       * The badge TEXT is `badgeText`; the style is the module-level `badge`
       * object — keep the names apart: handing text to style breaks React's
       * style contract (react.dev/errors/62) and can take the card down. */
      function fieldRow(key, label, value, badgeText, changeable, onOpen) {
        return React.createElement("div", {
          key: key,
          style: {
            display: "flex", alignItems: "center", gap: 10, minHeight: 44,
            padding: "6px 8px", borderTop: key === "first" ? "none" : "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.12))"
          }
        },
          React.createElement("span", { key: "label", style: Object.assign({}, groupTitle, { flex: "0 0 88px", padding: 0 }) }, label),
          React.createElement("span", {
            key: "value",
            style: { flex: "1 1 auto", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
          },
            badgeText ? React.createElement("span", { key: "badge", style: badge }, badgeText) : null,
            value
          ),
          changeable ? React.createElement("button", {
            key: "change", type: "button",
            style: Object.assign({}, button, { padding: "4px 14px", flex: "0 0 auto" }),
            disabled: busy,
            onClick: onOpen
          }, "更改") : null
        );
      }

      var reviewBlock = reviewOffer === null ? null : React.createElement("div", {
        key: "review",
        style: {
          margin: "10px 8px 4px", padding: "8px 10px",
          border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
          borderRadius: 12
        }
      },
        reviewFixed
          ? [
            React.createElement("div", {
              key: "fixed", style: { display: "flex", alignItems: "center", gap: 8, minHeight: 44, fontSize: 13 }
            },
              React.createElement("span", { style: badge }, FLAG_BADGE),
              React.createElement("span", null, "自动审核 · 开启，最多 " + review.rounds + " 轮")
            ),
            React.createElement("div", { key: "hint", style: empty },
              "执行者 = 新会话，审核者 = 当前会话；每轮交付自动送审，返工意见自动发回执行者。")
          ]
          : [
            React.createElement("label", {
              key: "toggle",
              style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer", minHeight: 44, fontSize: 13 }
            },
              React.createElement("input", {
                type: "checkbox", style: { width: 20, height: 20 },
                checked: review.enabled,
                onChange: function (event) { setReview({ enabled: event.target.checked, rounds: review.rounds }); }
              }),
              React.createElement("span", null, REVIEW_LABEL)
            ),
            review.enabled ? React.createElement("div", {
              key: "rounds",
              style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", padding: "2px 0 6px" }
            },
              [1, 2, 3, 5, 8].map(function (n) {
                return React.createElement("button", {
                  key: n, type: "button",
                  style: Object.assign({}, button, {
                    minHeight: 44, minWidth: 44, padding: "4px 10px", fontSize: 13,
                    background: review.rounds === n ? "var(--dsw-alias-accent-major, #4c6ef5)" : button.background,
                    color: review.rounds === n ? "#fff" : button.color
                  }),
                  onClick: function () { setReview({ enabled: true, rounds: n }); }
                }, String(n));
              }),
              React.createElement("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #9a9aa2)" } }, "轮预算")
            ) : null,
            review.enabled ? React.createElement("div", { key: "hint", style: empty },
              "执行者 = 新会话，审核者 = 当前会话；每轮交付（trigger_signal）自动送审，返工意见自动发回执行者，直到通过 / 需要用户 / 轮次用尽。")
              : React.createElement("div", { key: "off", style: empty }, "不开启则与普通交接完全一致。")
          ]
      );

      return React.createElement("div", {
        style: backdrop,
        onClick: function (event) { if (event.target === event.currentTarget) cancel(); }
      }, React.createElement("div", { style: card }, [
        React.createElement("div", { key: "header", style: header }, [
          React.createElement("div", { key: "title", style: title }, "交接任务"),
          React.createElement("div", { key: "task", style: subtitle }, request.task)
        ]),
        React.createElement("div", { key: "body", style: body },
          React.createElement("div", { style: { display: "flex", flexDirection: "column" } },
            [
              fieldRow("first", "模型", modelValue, modelLabel, !modelFixed, function () { setSection("model"); }),
              hasEfforts
                ? fieldRow("effort", "思考强度", effortValue, undefined, !modelFixed, function () { setSection("effort"); })
                : null,
              fieldRow("ws", "工作区", wsValue, fixedWorkspace ? FLAG_BADGE : undefined, wsChangeable, function () { setSection("workspace"); }),
              reviewBlock,
              React.createElement("div", { key: "note", style: Object.assign({}, empty, { marginTop: 6 }) },
                "点「开始交接」后，当前会话先写自包含简报，完成时在新工作区创建执行会话。")
            ].filter(Boolean)
          )
        ),
        errorLineEl,
        cardFooter
      ]));
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
      // One wizard instance per pending request: the key remounts the Picker
      // when a new pick arrives, so wizard state never leaks across requests.
      return React.createElement(Picker, {
        key: request.id,
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
