// Client half of dsh-auto-permit: the Settings section that picks the judge
// model. Plain JavaScript (no JSX), evaluated by the DSH client module loader.
//
// Registers one `settings.section` entry labeled 自动审批: an enabled toggle
// plus a model picker modeled on the /handoff picker — the catalog comes from
// the same Client Remote (`ctx.remote.session.modelCatalog()`), picking a
// model that advertises reasoning efforts opens a second step to choose one,
// and the choice is written through `ctx.remote.settings.update` into the
// `auto-permit` namespace the host half installed.
window.__ModuleLoader__.load({
  id: "dsh-auto-permit",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    var NS = "auto-permit";

    // --- styles (theme-token driven, so light/dark both work) ---
    var section = { display: "flex", flexDirection: "column", gap: "14px", padding: "18px 20px" };
    var intro = {
      fontSize: "13px", lineHeight: "20px",
      color: "var(--dsw-alias-label-tertiary, #9a9aa2)"
    };
    var rowLine = {
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px"
    };
    var label = { fontSize: "14px", lineHeight: "22px", fontWeight: 500 };
    var routeText = {
      fontSize: "12px", lineHeight: "18px",
      color: "var(--dsw-alias-label-tertiary, #9a9aa2)",
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
    };
    var button = {
      font: "inherit", fontSize: "13px", padding: "7px 14px", borderRadius: "10px",
      cursor: "pointer", flexShrink: "0",
      color: "var(--dsw-alias-label-primary, #e8e8ea)",
      background: "transparent",
      border: "1px solid var(--dsw-alias-border-l4, rgba(255,255,255,.16))"
    };
    var toggle = {
      width: "40px", height: "22px", borderRadius: "11px", cursor: "pointer",
      position: "relative", border: "none", padding: "0", flexShrink: "0",
      background: "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.14))",
      transition: "background .15s ease"
    };
    var toggleOn = {
      background: "var(--dsw-alias-button-info-fill, #8ab4ff)"
    };
    var knob = {
      position: "absolute", top: "3px", left: "3px", width: "16px", height: "16px",
      borderRadius: "50%", background: "#fff", transition: "left .15s ease"
    };
    var knobOn = { left: "21px" };
    var search = {
      padding: "8px 12px", font: "inherit", fontSize: "14px",
      color: "var(--dsw-alias-label-primary, #e8e8ea)",
      background: "var(--dsw-alias-bg-module-platform, rgba(255,255,255,.04))",
      border: "1px solid var(--dsw-alias-border-l4, rgba(255,255,255,.16))",
      borderRadius: "10px", outline: "none"
    };
    var list = {
      border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12))",
      borderRadius: "14px", overflowY: "auto", maxHeight: "40vh"
    };
    var groupTitle = {
      padding: "10px 12px 4px", fontSize: "11px", lineHeight: "16px",
      textTransform: "uppercase", letterSpacing: "0.04em",
      color: "var(--dsw-alias-label-tertiary, #9a9aa2)"
    };
    var item = {
      display: "flex", flexDirection: "column", gap: "2px", width: "100%",
      textAlign: "left", cursor: "pointer", padding: "8px 12px",
      background: "transparent", border: "none", color: "inherit", font: "inherit"
    };
    var itemLabel = { fontSize: "14px", lineHeight: "22px", fontWeight: 500 };
    var itemDesc = {
      fontSize: "12px", lineHeight: "18px",
      color: "var(--dsw-alias-label-tertiary, #9a9aa2)",
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
    };
    var errorLine = {
      fontSize: "12px", lineHeight: "18px",
      color: "var(--dsw-alias-state-error-primary, #f2727a)"
    };
    var emptyLine = {
      padding: "12px", fontSize: "13px",
      color: "var(--dsw-alias-label-tertiary, #9a9aa2)"
    };

    function Toggle(props) {
      var on = props.value === true;
      return React.createElement("button", {
        type: "button", style: Object.assign({}, toggle, on ? toggleOn : null),
        disabled: props.busy, onClick: props.onChange,
        "aria-pressed": on
      }, React.createElement("span", {
        style: Object.assign({}, knob, on ? knobOn : null)
      }));
    }

    /** Route label, e.g. `deepseek-v4-flash · deepseek-official/deepseek-v4-flash · 强度 low`. */
    function routeLabel(entry, catalog) {
      if (!entry || !entry.provider || !entry.model) return "未配置（自动审批未生效）";
      var name = null;
      var groups = catalog && catalog.groups ? catalog.groups : [];
      for (var g = 0; g < groups.length; g += 1) {
        if (groups[g].id !== entry.provider) continue;
        for (var m = 0; m < groups[g].models.length; m += 1) {
          if (groups[g].models[m].id === entry.model) name = groups[g].models[m].name;
        }
      }
      var parts = [];
      if (name) parts.push(name);
      parts.push(entry.provider + "/" + entry.model);
      if (entry.reasoningEffort) parts.push("强度 " + entry.reasoningEffort);
      return parts.join(" · ");
    }

    /** The Settings section component. */
    function AutoPermitSection(props) {
      var operations = props.operations;

      var entryState = React.useState(null);
      var entry = entryState[0];
      var setEntry = entryState[1];
      var revisionState = React.useState(0);
      var revision = revisionState[0];
      var setRevision = revisionState[1];
      var pickingState = React.useState(false);
      var picking = pickingState[0];
      var setPicking = pickingState[1];
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
      // Non-null while the effort step is showing for one picked model.
      var effortState = React.useState(null);
      var effortFor = effortState[0];
      var setEffortFor = effortState[1];

      React.useEffect(function () {
        var alive = true;
        operations.read().then(function (result) {
          if (!alive) return;
          if (result && result.ok) {
            setEntry(result.value);
            setRevision(result.revision);
          } else {
            setError("设置读取失败");
          }
        }).catch(function (err) { if (alive) setError(String(err)); });
        return function () { alive = false; };
      }, []);

      React.useEffect(function () {
        if (!picking || catalog !== null) return undefined;
        var alive = true;
        operations.modelCatalog().then(function (result) {
          if (!alive) return;
          if (result && result.ok === true) {
            setCatalog(result.value);
          } else {
            var failure = result && result.error ? result.error : null;
            setError(failure && failure.message ? failure.message : "模型目录加载失败");
          }
        }).catch(function (err) { if (alive) setError(String(err)); });
        return function () { alive = false; };
      }, [picking]);

      // Writes go through `replace` (the whole next section), so switching to
      // a model without reasoning efforts cleanly drops a stale effort —
      // a merge patch could not express that removal.
      function write(next) {
        setBusy(true);
        setError(null);
        operations.write(next, revision).then(function (result) {
          setBusy(false);
          if (result && result.ok) {
            setEntry(result.value);
            setRevision(result.revision);
            setPicking(false);
            setEffortFor(null);
          } else {
            setError(result && result.message ? result.message : "保存失败");
          }
        }).catch(function (err) {
          setBusy(false);
          setError(String(err));
        });
      }

      function chooseModel(provider, model) {
        var reasoning = model.reasoning;
        var efforts = reasoning && reasoning.efforts ? reasoning.efforts : [];
        if (efforts.length === 0) {
          write({ enabled: entry.enabled !== false, provider: provider, model: model.id });
          return;
        }
        setEffortFor({ provider: provider, model: model.id, name: model.name, efforts: efforts });
      }

      function chooseEffort(effortId) {
        var next = { enabled: entry.enabled !== false, provider: effortFor.provider, model: effortFor.model };
        if (effortId !== undefined) next.reasoningEffort = effortId;
        write(next);
      }

      var children = [
        React.createElement("div", { key: "intro", style: intro },
          "sandbox 提权重试触发审批时，由下方判官模型依据本会话的用户指令与已批准命令自动放行；判官不确定时仍会弹窗询问。不可逆操作（rm -rf ~、git clean -xfd、reset --hard、push --force、sudo 等）始终交人工。判官模型必须显式指定，不跟随会话模型。"),
        entry === null
          ? React.createElement("div", { key: "loading", style: emptyLine }, "正在读取设置…")
          : React.createElement("div", { key: "toggle", style: rowLine }, [
              React.createElement("div", { key: "lab", style: label }, "启用自动审批"),
              React.createElement(Toggle, {
                key: "t", value: entry.enabled === true, busy: busy,
                onChange: function () {
                  var next = {
                    enabled: !(entry.enabled === true),
                    provider: entry.provider,
                    model: entry.model
                  };
                  if (entry.reasoningEffort) next.reasoningEffort = entry.reasoningEffort;
                  write(next);
                }
              })
            ]),
        entry !== null ? React.createElement("div", { key: "route", style: rowLine }, [
            React.createElement("div", { key: "info", style: { minWidth: "0" } }, [
              React.createElement("div", { key: "l", style: label }, "判官模型"),
              React.createElement("div", { key: "r", style: routeText }, routeLabel(entry, catalog))
            ]),
            React.createElement("button", {
              key: "pick", type: "button", style: button, disabled: busy,
              onClick: function () {
                setError(null); setQuery(""); setEffortFor(null); setPicking(!picking);
              }
            }, picking ? "收起" : entry && entry.model ? "更换模型" : "选择模型")
          ]) : null
      ];

      if (entry !== null && picking) {
        var pickerChildren = [];
        if (effortFor !== null) {
          pickerChildren.push(
            React.createElement("div", { key: "eh", style: groupTitle },
              effortFor.name + " · 思考强度")
          );
          effortFor.efforts.forEach(function (effort) {
            pickerChildren.push(React.createElement("button", {
              key: "e:" + effort.id, type: "button", style: item, disabled: busy,
              onClick: function () { chooseEffort(effort.id); }
            }, [
              React.createElement("span", { key: "l", style: itemLabel }, effort.name),
              effort.description
                ? React.createElement("span", { key: "d", style: itemDesc }, effort.description)
                : null
            ]));
          });
          pickerChildren.push(React.createElement("button", {
            key: "e:default", type: "button", style: item, disabled: busy,
            onClick: function () { chooseEffort(undefined); }
          }, React.createElement("span", { style: itemLabel }, "默认强度")));
          pickerChildren.push(React.createElement("button", {
            key: "back", type: "button", style: Object.assign({}, item, { color: "var(--dsw-alias-label-tertiary, #9a9aa2)" }),
            onClick: function () { setEffortFor(null); }
          }, React.createElement("span", { style: itemLabel }, "← 返回模型列表")));
        } else {
          pickerChildren.push(React.createElement("input", {
            key: "search", style: search, value: query, placeholder: "搜索模型 / 厂商…",
            onChange: function (event) { setQuery(event.target.value); }
          }));
          var needle = query.trim().toLowerCase();
          var allGroups = catalog && catalog.groups ? catalog.groups : [];
          var shown = 0;
          allGroups.forEach(function (group) {
            var kept = group.models.filter(function (model) {
              var haystack = (model.name + " " + model.id + " " + (model.description || "") + " " + group.name).toLowerCase();
              return needle.length === 0 || haystack.indexOf(needle) >= 0;
            });
            if (kept.length === 0) return;
            shown += kept.length;
            pickerChildren.push(React.createElement("div", { key: "g:" + group.id, style: groupTitle }, group.name));
            kept.forEach(function (model) {
              var description = [];
              if (model.name !== model.id) description.push(model.id);
              if (model.description) description.push(model.description);
              pickerChildren.push(React.createElement("button", {
                key: "m:" + group.id + "/" + model.id, type: "button", style: item,
                disabled: busy, onClick: function () { chooseModel(group.id, model); }
              }, [
                React.createElement("span", { key: "l", style: itemLabel }, model.name),
                description.length > 0
                  ? React.createElement("span", { key: "d", style: itemDesc }, description.join(" · "))
                  : null
              ]));
            });
          });
          if (catalog === null && error === null) {
            pickerChildren.push(React.createElement("div", { key: "loading", style: emptyLine }, "正在加载模型目录…"));
          } else if (shown === 0) {
            pickerChildren.push(React.createElement("div", { key: "none", style: emptyLine }, "没有可用的模型"));
          }
        }
        children.push(React.createElement("div", { key: "picker", style: list }, pickerChildren));
      }

      if (error !== null) {
        children.push(React.createElement("div", { key: "error", style: errorLine }, error));
      }

      return React.createElement("div", { style: section }, children);
    }

    function apply(ctx) {
      var operations = {
        read: function () {
          return ctx.remote.settings.describe().then(function (envelope) {
            if (!envelope || envelope.ok !== true) {
              return { ok: false, message: "settings describe failed" };
            }
            var namespaces = envelope.value && envelope.value.namespaces ? envelope.value.namespaces : [];
            for (var i = 0; i < namespaces.length; i += 1) {
              if (namespaces[i].ns === NS) {
                var value = namespaces[i].value || {};
                return {
                  ok: true,
                  value: {
                    enabled: value.enabled !== false,
                    provider: typeof value.provider === "string" ? value.provider : "",
                    model: typeof value.model === "string" ? value.model : "",
                    reasoningEffort: typeof value.reasoningEffort === "string" ? value.reasoningEffort : undefined
                  },
                  revision: namespaces[i].revision
                };
              }
            }
            return { ok: false, message: "auto-permit settings namespace missing (host half not loaded?)" };
          });
        },
        write: function (section, revision) {
          return ctx.remote.settings.replace(NS, section, revision).then(function (envelope) {
            if (!envelope || envelope.ok !== true) {
              return { ok: false, message: envelope && envelope.error ? envelope.error.message || "保存失败" : "保存失败" };
            }
            var value = envelope.value && envelope.value.value ? envelope.value.value : {};
            return {
              ok: true,
              value: {
                enabled: value.enabled !== false,
                provider: typeof value.provider === "string" ? value.provider : "",
                model: typeof value.model === "string" ? value.model : "",
                reasoningEffort: typeof value.reasoningEffort === "string" ? value.reasoningEffort : undefined
              },
              revision: envelope.value.revision
            };
          });
        },
        modelCatalog: function () { return ctx.remote.session.modelCatalog(); }
      };
      var injected = function () { return { operations: operations }; };
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "auto-permit",
          order: 15,
          label: function () { return "自动审批"; },
          inject: injected
        }, AutoPermitSection);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote", "remote.session", "remote.settings"];
    return module.exports;
  }
});
