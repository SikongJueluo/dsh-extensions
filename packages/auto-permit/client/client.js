// Client half of dsh-auto-permit: the Settings section that picks the judge
// model. Plain JavaScript (no JSX), evaluated by the DSH client module loader.
//
// One `settings.section` entry labeled "Auto Permit": an enabled toggle, one
// native <select> listing every model from the shared catalog (grouped by
// provider), and — when the picked model advertises reasoning efforts — a
// second <select> for the effort. Every change edits the PLUGIN ROW CONFIG
// through the stock `remote.settings` channel (same as the permission-presets
// UI), so the row config stays the single source of truth:
//
//   - bundle-installed rows (dsh plugin add): edits persist and apply live;
//   - rows contributed by a `--patch` overlay (e.g. the nixos insert layer):
//     the write is refused with "overridden by a home patch or command-line
//     overlay" — the section surfaces that as a "managed by your overlay
//     declaration" notice instead of a generic failure.
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
    var row = { display: "flex", flexDirection: "column", gap: "6px" };
    var label = { fontSize: "13px", lineHeight: "18px", fontWeight: 500 };
    var select = {
      font: "inherit", fontSize: "14px", padding: "8px 10px", width: "100%",
      color: "var(--dsw-alias-label-primary, #e8e8ea)",
      background: "var(--dsw-alias-bg-module-platform, rgba(255,255,255,.04))",
      border: "1px solid var(--dsw-alias-border-l4, rgba(255,255,255,.16))",
      borderRadius: "10px", outline: "none"
    };
    var toggle = {
      width: "40px", height: "22px", borderRadius: "11px", cursor: "pointer",
      position: "relative", border: "none", padding: "0", flexShrink: "0",
      background: "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.14))",
      transition: "background .15s ease"
    };
    var toggleOn = { background: "var(--dsw-alias-button-info-fill, #8ab4ff)" };
    var knob = {
      position: "absolute", top: "3px", left: "3px", width: "16px", height: "16px",
      borderRadius: "50%", background: "#fff", transition: "left .15s ease"
    };
    var knobOn = { left: "21px" };
    var toggleRow = {
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px"
    };
    var status = {
      fontSize: "12px", lineHeight: "18px",
      color: "var(--dsw-alias-label-tertiary, #9a9aa2)"
    };
    var errorLine = {
      fontSize: "12px", lineHeight: "18px",
      color: "var(--dsw-alias-state-error-primary, #f2727a)"
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

    /** The catalog entry of one model, or null when absent/not loaded. */
    function catalogModel(catalog, provider, model) {
      var groups = catalog && catalog.groups ? catalog.groups : [];
      for (var g = 0; g < groups.length; g += 1) {
        if (groups[g].id !== provider) continue;
        for (var m = 0; m < groups[g].models.length; m += 1) {
          if (groups[g].models[m].id === model) return groups[g].models[m];
        }
      }
      return null;
    }

    /** Project one settings namespace view into the editor's entry shape. */
    function entryOf(view) {
      var value = view && view.value ? view.value : {};
      return {
        enabled: value.enabled !== false,
        provider: typeof value.provider === "string" ? value.provider : "",
        model: typeof value.model === "string" ? value.model : "",
        reasoningEffort: typeof value.reasoningEffort === "string" ? value.reasoningEffort : undefined,
        revision: view.revision
      };
    }

    /** The Settings section component. */
    function AutoPermitSection(props) {
      var operations = props.operations;

      var entryState = React.useState(null);
      var entry = entryState[0];
      var setEntry = entryState[1];
      var catalogState = React.useState(null);
      var catalog = catalogState[0];
      var setCatalog = catalogState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];
      var managedState = React.useState(false);
      var managed = managedState[0];
      var setManaged = managedState[1];

      React.useEffect(function () {
        var alive = true;
        operations.read().then(function (result) {
          if (!alive) return;
          if (result && result.ok) {
            setEntry(result.value);
          } else {
            setError(result && result.message ? result.message : "Failed to read the configuration.");
          }
        }).catch(function () { if (alive) setError("Failed to read the configuration."); });
        operations.modelCatalog().then(function (result) {
          if (!alive) return;
          if (result && result.ok === true) setCatalog(result.value);
          else setError("Failed to load the model catalog.");
        }).catch(function () { if (alive) setError("Failed to load the model catalog."); });
        return function () { alive = false; };
      }, []);

      function write(patch) {
        setBusy(true);
        setError(null);
        setManaged(false);
        operations.write(patch, entry.revision).then(function (result) {
          setBusy(false);
          if (result && result.ok) {
            setEntry(result.value);
            return;
          }
          var message = result && result.message ? result.message : "Save failed.";
          if (message.indexOf("overridden by a home patch") >= 0) setManaged(true);
          else setError(message);
        }).catch(function () {
          setBusy(false);
          setError("Save failed.");
        });
      }

      if (entry === null) {
        return React.createElement("div", { style: section },
          React.createElement("div", { style: status }, "Loading…"));
      }

      var picked = catalogModel(catalog, entry.provider, entry.model);
      var efforts = picked && picked.reasoning && picked.reasoning.efforts ? picked.reasoning.efforts : [];
      var effortValid = efforts.some(function (effort) { return effort.id === entry.reasoningEffort; });

      var children = [
        React.createElement("div", { key: "intro", style: intro },
          "Before a bash sandbox escalation reaches the approval dialog, a judge model checks it against this session's user prompts and previously approved commands; anything it cannot ground falls back to the human dialog. Irreversible shapes (rm -rf ~, git clean -xfd, reset --hard, push --force, sudo, curl|sh…) always go to the human. The judge model must be picked explicitly — it never follows the session model."),
        React.createElement("div", { key: "toggle", style: toggleRow }, [
          React.createElement("span", { key: "l", style: label }, "Enabled"),
          React.createElement(Toggle, {
            key: "t", value: entry.enabled === true, busy: busy,
            onChange: function () {
              write({ enabled: !(entry.enabled === true) });
            }
          })
        ]),
        React.createElement("div", { key: "model", style: row }, [
          React.createElement("span", { key: "l", style: label }, "Judge model"),
          React.createElement("select", {
            key: "s", style: select, disabled: busy || catalog === null,
            value: entry.provider + "/" + entry.model,
            onChange: function (event) {
              var value = event.target.value;
              if (value === "") {
                write({ provider: "", model: "" });
                return;
              }
              var slash = value.indexOf("/");
              var provider = value.slice(0, slash);
              var model = value.slice(slash + 1);
              var patch = { provider: provider, model: model };
              // Switching models keeps the effort only when the new model has it.
              if (entry.reasoningEffort) {
                var next = catalogModel(catalog, provider, model);
                var kept = next && next.reasoning && next.reasoning.efforts
                  ? next.reasoning.efforts.some(function (e) { return e.id === entry.reasoningEffort; })
                  : false;
                if (!kept) write({ provider: provider, model: model, reasoningEffort: null });
                else write(patch);
                return;
              }
              write(patch);
            }
          }, catalog === null
            ? [React.createElement("option", { key: "loading", value: "" }, "Loading models…")]
            : [React.createElement("option", { key: "none", value: "" },
                "Not configured — auto-permit stays inactive")].concat(
                (catalog.groups || []).map(function (group) {
                  return React.createElement("optgroup", { key: "g:" + group.id, label: group.name },
                    group.models.map(function (model) {
                      var value = group.id + "/" + model.id;
                      return React.createElement("option", {
                        key: value, value: value
                      }, model.name !== model.id ? model.name + " (" + model.id + ")" : model.id);
                    }));
                })))
        ])
      ];

      if (efforts.length > 0) {
        children.push(React.createElement("div", { key: "effort", style: row }, [
          React.createElement("span", { key: "l", style: label }, "Reasoning effort"),
          React.createElement("select", {
            key: "s", style: select, disabled: busy,
            value: effortValid ? entry.reasoningEffort : "",
            onChange: function (event) {
              var value = event.target.value;
              // A null clears the field (settings update path-op semantics).
              write(value === "" ? { reasoningEffort: null } : { reasoningEffort: value });
            }
          }, [React.createElement("option", { key: "default", value: "" }, "Default")].concat(
            efforts.map(function (effort) {
              return React.createElement("option", { key: effort.id, value: effort.id },
                effort.name !== effort.id ? effort.name + " (" + effort.id + ")" : effort.id);
            })))
        ]));
      }

      if (managed) {
        children.push(React.createElement("div", { key: "managed", style: status },
          "This row is contributed by a home patch / command-line overlay (e.g. your NixOS plugin declaration). Edit its config there and rebuild; the Web form cannot override the defining layer."));
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
              if (namespaces[i].ns === NS) return { ok: true, value: entryOf(namespaces[i]) };
            }
            return { ok: false, message: "auto-permit row is not mounted" };
          });
        },
        write: function (patch, revision) {
          var ops = Object.keys(patch).map(function (key) {
            // A null value means "clear this optional field" → unset path op.
            return patch[key] === null
              ? { op: "unset", path: [key] }
              : { op: "set", path: [key], value: patch[key] };
          });
          return ctx.remote.settings.mutate(NS, ops, revision).then(function (envelope) {
            if (!envelope || envelope.ok !== true) {
              return {
                ok: false,
                message: envelope && envelope.error && envelope.error.message
                  ? envelope.error.message : "Save failed."
              };
            }
            return { ok: true, value: entryOf(envelope.value) };
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
          label: function () { return "Auto Permit"; },
          inject: injected
        }, AutoPermitSection);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote", "remote.session", "remote.settings"];
    return module.exports;
  }
});
