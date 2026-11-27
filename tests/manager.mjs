/** Real Handlebars/DOM manager tests, with mocked Foundry documents and transport. */
export async function runManagerTests({
    test,
    assert,
    equal,
    actor,
    feat,
    attunement,
    add,
    doc,
    documents,
    manager,
    wandering,
    core,
    App,
}) {
    const data = await import("../scripts/manager-data.mjs");
    const wait = (ms = 35) => new Promise((r) => setTimeout(r, ms));
    const originalRead = globalThis.fromUuid;
    const originalLocalize = game.i18n.localize,
        originalFormat = game.i18n.format;
    const lang = await (await fetch("../lang/ru.json")).json();
    const translate = (key) => key.split(".").reduce((v, k) => v?.[k], lang) ?? key;
    game.i18n.localize = translate;
    game.i18n.format = (key, args) => translate(key).replace(/\{(\w+)\}/g, (_, key) => args[key] ?? "");
    const template = globalThis.Handlebars.compile(await (await fetch("../templates/manage-apparitions.hbs")).text());
    globalThis.Handlebars.registerHelper("localize", translate);
    const apps = [];
    const reset = () => {
        data.invalidateManagerData();
        wandering.resetWanderingCache();
        globalThis.fromUuid = originalRead;
    };
    const appFor = () => {
        const a = actor();
        attunement(a);
        const app = new manager.ManageApparitionsApp(a);
        apps.push(app);
        return app;
    };
    const apparition = (key, name) => {
        const item = doc({
            type: "feat",
            name,
            system: {
                rules: [],
                traits: { value: ["animist"], otherTags: ["animist-apparition"] },
                description: { value: "<ul></ul>" },
            },
        });
        item.uuid = key;
        documents.set(key, item);
        return item;
    };
    async function paint(app) {
        app.captureUI();
        const context = await app._prepareContext({});
        if (app.closed) return app;
        const root = document.createElement("div");
        root.innerHTML = template(context);
        const old = app.element;
        app.element = root;
        if (old?.isConnected) old.replaceWith(root);
        else document.getElementById("fixture").append(root);
        app._attachPartListeners("manage", root, {});
        app._onRender(context, {});
        return app;
    }
    App.renderer = paint;
    const run = async (name, fn) =>
        test(name, async () => {
            reset();
            try {
                await fn();
            } finally {
                for (const app of apps.splice(0)) {
                    await app.close();
                    app.element?.remove();
                }
                reset();
            }
        });
    await run("manager first context does not await a cold or stalled catalogue", async () => {
        let reads = 0;
        game.packs.set("pf2e.classfeatures", {
            getIndex: () => {
                reads++;
                return new Promise(() => {});
            },
        });
        const app = appFor();
        feat(app.actor, "Item.visible");
        const context = await app._prepareContext({});
        equal(reads, 0);
        equal(context.bonded.length, 1);
        assert(context.availableLoading);
        // Do not start the intentionally non-resolving request in the test runner.
    });
    await run("catalogue parses references without resolving any spell documents", async () => {
        let reads = 0;
        globalThis.fromUuid = async () => {
            reads++;
            throw Error("eager read");
        };
        const f = feat(actor(), "Item.catalogue");
        game.packs.set("pf2e.classfeatures", { getIndex: async () => [f] });
        const list = await data.loadAvailableApparitions();
        assert(list.some((entry) => entry.uuid === "Item.catalogue"));
        equal(reads, 0);
        equal(list.find((entry) => entry.uuid === "Item.catalogue").vesselUuid, "Item.vessel");
    });
    await run("concurrent detail expansions share UUID reads and successful details", async () => {
        let reads = 0;
        const spell = doc({ type: "spell", name: "One", system: { level: { value: 2 }, traits: { value: [] } } });
        globalThis.fromUuid = async () => {
            reads++;
            await wait(1);
            return spell;
        };
        const a = { uuid: "Item.one", spellUuids: [spell.uuid], vesselUuid: null, lores: [] };
        const b = { ...a, uuid: "Item.two" };
        const [x, y] = await Promise.all([data.getApparitionDetails(a), data.getApparitionDetails(b)]);
        equal(reads, 1);
        equal(x.spells.length, 1);
        equal(y.spells.length, 1);
        await data.getApparitionDetails(a);
        equal(reads, 1);
    });
    await run("UUID resolver bounds actual parallel reads to six", async () => {
        let active = 0,
            max = 0;
        globalThis.fromUuid = async (uuid) => {
            active++;
            max = Math.max(max, active);
            await wait(2);
            active--;
            return { uuid };
        };
        await Promise.all(Array.from({ length: 19 }, (_, i) => data.resolveManagerDocument(`Item.limit${i}`)));
        equal(max, 6);
        equal(active, 0);
    });
    await run("partial spell failure preserves successes and supports explicit retry", async () => {
        const spell = doc({ type: "spell", name: "Good", system: { level: { value: 1 }, traits: { value: [] } } });
        let fail = true;
        globalThis.fromUuid = async (uuid) => {
            if (uuid === "Item.bad" && fail) throw Error("network");
            return spell;
        };
        const summary = { uuid: "Item.partial", spellUuids: [spell.uuid, "Item.bad"], vesselUuid: null, lores: [] };
        const first = await data.getApparitionDetails(summary);
        equal(first.spells.length, 1);
        equal(first.errors, ["Item.bad"]);
        fail = false;
        const second = await data.getApparitionDetails(summary, { force: true });
        equal(second.errors, []);
    });
    await run("timeout reports a local deadline rather than waiting forever", async () => {
        let code;
        try {
            await data.withTimeout(new Promise(() => {}), 3);
        } catch (e) {
            code = e.code;
        }
        equal(code, "BMO_TIMEOUT");
    });
    await run("invalidated catalogue cannot overwrite a newer successful request", async () => {
        let release;
        game.packs.set("pf2e.classfeatures", { getIndex: () => new Promise((r) => (release = r)) });
        const old = data.loadAvailableApparitions();
        await wait(1);
        data.invalidateManagerData();
        game.packs.set("pf2e.classfeatures", { getIndex: async () => [] });
        await data.loadAvailableApparitions();
        release([]);
        await old;
        equal(data.getCatalogErrors(), []);
    });
    await run("real template renders three accessible tabs without missing localization keys", async () => {
        const app = appFor();
        await paint(app);
        const root = app.element;
        equal(root.querySelectorAll('[role="tab"]').length, 3);
        equal(root.querySelectorAll('[role="tabpanel"]:not([hidden])').length, 1);
        assert(!root.textContent.includes("pf2e-dailies-apparition-fix."), root.textContent);
        assert(root.querySelector('[data-ui-section="advanced"]') && !root.querySelector('[data-ui-section="advanced"]').open);
        for (const tab of root.querySelectorAll('[role="tab"]')) assert(root.querySelector(`[id="${tab.getAttribute("aria-controls")}"]`));
    });
    await run("first rendered actor controls precede deferred catalogue completion", async () => {
        let release;
        game.packs.set("pf2e.classfeatures", { getIndex: () => new Promise((r) => (release = r)) });
        const app = appFor();
        feat(app.actor, "Item.bonded");
        await paint(app);
        assert(app.element.querySelector('[data-action="unbond"]'));
        assert(app.availableLoading);
        assert(app.metrics.firstRenderMs !== null);
        release([]);
        await wait();
        assert(!app.availableLoading);
    });
    await run("spell details load on expansion, not initial render", async () => {
        let reads = 0;
        const spell = doc({ type: "spell", name: "Vessel", system: { level: { value: 1 }, traits: { value: [] } } });
        globalThis.fromUuid = async () => {
            reads++;
            return spell;
        };
        const app = appFor();
        feat(app.actor, "Item.expand");
        await paint(app);
        await wait();
        equal(reads, 0);
        app.element.querySelector("details[data-detail-key]").open = true;
        await wait(80);
        equal(reads, 1);
        assert(app.element.querySelector('[data-action="open-spell-source"]'));
    });
    await run("search, open cards, field drafts, scroll and tab survive rerender", async () => {
        const app = appFor();
        feat(app.actor, "Item.state");
        await paint(app);
        await wait();
        const root = app.element;
        const input = root.querySelector('[data-role="apparition-search"]');
        input.value = "ничего";
        input.dispatchEvent(new Event("input"));
        root.querySelector('[name="profileName"]').value = "Черновик";
        const details = root.querySelector("details[data-detail-key]");
        details.open = true;
        root.querySelector('[data-ui-section="advanced"]').open = true;
        await wait(80);
        app.captureUI();
        app.activateTab("profiles");
        await paint(app);
        await wait();
        equal(app.element.querySelector('[name="profileName"]').value, "Черновик");
        equal(app.element.querySelector('[data-role="apparition-search"]').value, "ничего");
        assert(app.element.querySelector("details[data-detail-key]").open);
        assert(app.element.querySelector('[data-ui-section="advanced"]').open);
        equal(app.element.querySelector('[role="tab"][aria-selected="true"]').dataset.managerTab, "profiles");
    });
    await run("random binding uses current search state rather than stale DOM visibility", async () => {
        const app = appFor();
        const alpha = apparition("Item.alpha", "Alpha");
        const beta = apparition("Item.beta", "Beta");
        app.available = [data.summarizeApparition(alpha), data.summarizeApparition(beta)];
        app.availableLoading = false;
        app.started = true;
        await paint(app);

        const input = app.element.querySelector('[data-role="apparition-search"]');
        input.value = "beta";
        input.dispatchEvent(new Event("input"));
        const alphaRow = app.element.querySelector('[data-action="bond"][data-uuid="Item.alpha"]').closest("[data-searchable]");
        const betaRow = app.element.querySelector('[data-action="bond"][data-uuid="Item.beta"]').closest("[data-searchable]");
        alphaRow.hidden = false;
        betaRow.hidden = true;

        const originalRandom = Math.random;
        Math.random = () => 0;
        try {
            app.element.querySelector('[data-action="bond-random"]').click();
            await wait(80);
        } finally {
            Math.random = originalRandom;
        }
        equal(
            core.getBondedApparitionFeats(app.actor).map((item) => item.name),
            ["Beta"],
        );
    });
    await run("random binding excludes apparitions bonded after the last render", async () => {
        const app = appFor();
        const alpha = apparition("Item.alpha", "Alpha");
        const beta = apparition("Item.beta", "Beta");
        app.available = [data.summarizeApparition(alpha), data.summarizeApparition(beta)];
        app.availableLoading = false;
        app.started = true;
        await paint(app);
        await core.addApparition(app.actor, alpha);

        const originalRandom = Math.random;
        Math.random = () => 0;
        try {
            app.element.querySelector('[data-action="bond-random"]').click();
            await wait(80);
        } finally {
            Math.random = originalRandom;
        }
        equal(
            core
                .getBondedApparitionFeats(app.actor)
                .map((item) => item.name)
                .sort(),
            ["Alpha", "Beta"],
        );
    });
    await run("random binding with no search matches does not bind an apparition", async () => {
        const app = appFor();
        app.available = [data.summarizeApparition(apparition("Item.alpha", "Alpha"))];
        app.availableLoading = false;
        app.started = true;
        await paint(app);
        const input = app.element.querySelector('[data-role="apparition-search"]');
        input.value = "nothing";
        input.dispatchEvent(new Event("input"));
        app.element.querySelector('[data-action="bond-random"]').click();
        await wait(80);
        equal(core.getBondedApparitionFeats(app.actor).length, 0);
    });
    await run("random binding selects the only search match", async () => {
        const app = appFor();
        app.available = [
            data.summarizeApparition(apparition("Item.alpha", "Alpha")),
            data.summarizeApparition(apparition("Item.beta", "Beta")),
        ];
        app.availableLoading = false;
        app.started = true;
        await paint(app);
        const input = app.element.querySelector('[data-role="apparition-search"]');
        input.value = "beta";
        input.dispatchEvent(new Event("input"));
        app.element.querySelector('[data-action="bond-random"]').click();
        await wait(80);
        equal(
            core.getBondedApparitionFeats(app.actor).map((item) => item.name),
            ["Beta"],
        );
    });
    await run("rapid random clicks do not create duplicate bonds", async () => {
        const app = appFor();
        app.available = [
            data.summarizeApparition(apparition("Item.alpha", "Alpha")),
            data.summarizeApparition(apparition("Item.beta", "Beta")),
        ];
        app.availableLoading = false;
        app.started = true;
        await paint(app);
        const button = app.element.querySelector('[data-action="bond-random"]');
        button.click();
        button.click();
        await wait(100);
        equal(core.getBondedApparitionFeats(app.actor).length, 1);
    });
    await run("tab keyboard navigation and native buttons work", async () => {
        const app = appFor();
        await paint(app);
        app.element.querySelector('[role="tab"]').dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
        equal(app.uiState.tab, "profiles");
        assert(document.activeElement.dataset.managerTab === "profiles");
        const input = app.element.querySelector('[data-role="apparition-search"]');
        input.value = "x";
        input.dispatchEvent(new Event("input"));
        app.element.querySelector('[data-action="clear-search"]').click();
        equal(input.value, "");
        equal(app.uiState.search, "");
    });
    await run("profile preview reads only the selected profile, not every saved profile", async () => {
        const app = appFor();
        await app.actor.setFlag("pf2e-dailies-apparition-fix", "apparitionProfiles", [
            { id: "one", name: "One", apparitions: ["Item.selected"], primary: [] },
            { id: "two", name: "Two", apparitions: ["Item.never"], primary: [] },
        ]);
        // Use the public save function to stay aligned with the module's profile schema.
        if (!core.getApparitionProfiles(app.actor).length) throw Error("profile fixture schema changed");
        const reads = [];
        globalThis.fromUuid = async (uuid) => {
            reads.push(uuid);
            return doc({ type: "feat", name: uuid });
        };
        await app._prepareContext({});
        equal(reads, []);
        app.uiState.profileId = "one";
        await app.ensureProfile();
        equal(reads, ["Item.selected"]);
    });
    await run("closed windows ignore late catalogue and profile completions", async () => {
        const app = appFor();
        let release;
        game.packs.set("pf2e.classfeatures", { getIndex: () => new Promise((r) => (release = r)) });
        const pending = app.reloadAvailable();
        await wait(1);
        await app.close();
        release([]);
        await pending;
        assert(app.closed);
        assert(!app.renderTimer);
        assert(app.metrics.catalog === null);
    });
    await run("window size and drafts survive closing and reopening for the same Actor", async () => {
        const app = appFor();
        await paint(app);
        app.element.querySelector('[name="profileName"]').value = "Saved draft";
        app.position = { width: 900, height: 750 };
        await app.close();
        const next = new manager.ManageApparitionsApp(app.actor);
        apps.push(next);
        equal(next.options.position, { width: 900, height: 750 });
        equal(next.uiState.fields.profileName, "Saved draft");
    });
    await run("quantity is informational and never disables bond controls", async () => {
        const app = appFor();
        for (let i = 0; i < 6; i++) feat(app.actor, `Item.extra${i}`);
        const other = feat(actor(), "Item.extraAvailable");
        app.available = [data.summarizeApparition(other)];
        app.availableLoading = false;
        app.started = true;
        await paint(app);
        assert(!app.element.querySelector('[data-action="bond"]').disabled);
        equal(core.getAttunementSummary(app.actor).count, 6);
    });
    await run("abilities load independently of the catalogue and only after tab activation", async () => {
        const app = appFor();
        add(app.actor, {
            type: "feat",
            name: "Wandering",
            system: { category: "class", level: { value: 6, taken: 6 }, traits: { value: ["animist", "wandering"] } },
        });
        let calls = 0;
        game.packs.set("pf2e.feats-srd", {
            getIndex: async () => {
                calls++;
                return [];
            },
        });
        await paint(app);
        await wait();
        equal(calls, 0);
        app.activateTab("abilities");
        await wait();
        equal(calls, 1);
        assert(app.wanderingState.status === "ready");
    });
    await run("selected profile missing sources remain marked and can be retried", async () => {
        const app = appFor();
        await app.actor.setFlag("pf2e-dailies-apparition-fix", "apparitionProfiles", [
            { id: "missing", name: "Missing", apparitions: ["Item.absent"], primary: [] },
        ]);
        globalThis.fromUuid = async () => null;
        app.uiState.profileId = "missing";
        await app.ensureProfile();
        equal(app.profilePreview.status, "error");
        assert((await app._prepareContext({})).previewRows[0].missing);
        globalThis.fromUuid = async () => doc({ type: "feat", name: "Recovered" });
        await app.ensureProfile({ force: true });
        equal(app.profilePreview.status, "ready");
    });
    await run("late older detail request cannot overwrite a forced refresh", async () => {
        const app = appFor();
        feat(app.actor, "Item.old-details");
        let release;
        globalThis.fromUuid = () => new Promise((r) => (release = r));
        const older = app.loadDetails("Item.old-details");
        await wait(1);
        const fresh = doc({ type: "spell", name: "Fresh", system: { traits: { value: ["cantrip"] }, level: { value: 0 } } });
        globalThis.fromUuid = async () => fresh;
        await app.loadDetails("Item.old-details", { force: true });
        release(doc({ type: "spell", name: "Old", system: { traits: { value: ["cantrip"] }, level: { value: 0 } } }));
        await older;
        equal(app.details.get("Item.old-details").data.vessel.name, "Fresh");
    });
    await run("save profile via real controls keeps the newly created selection", async () => {
        const app = appFor();
        feat(app.actor, "Item.profile-save");
        await paint(app);
        await wait();
        app.activateTab("profiles");
        app.element.querySelector('[name="profileName"]').value = "Новый профиль";
        app.element.querySelector('[data-action="save-profile"]').click();
        await wait(80);
        const profiles = core.getApparitionProfiles(app.actor);
        equal(profiles.length, 1);
        equal(app.element.querySelector('[name="profileId"]').value, profiles[0].id);
        equal(app.uiState.profileId, profiles[0].id);
    });
    await run("catalogue error is local and its retry control restores entries", async () => {
        const app = appFor();
        let attempts = 0;
        const f = feat(actor(), "Item.retry-catalog");
        game.packs.set("pf2e.classfeatures", {
            getIndex: async () => {
                if (++attempts === 1) throw Error("expected test transport failure");
                return [f];
            },
        });
        // Expected backend error is asserted below, not treated as an unexpected runtime error.
        const log = console.error;
        const expected = [];
        console.error = (...args) => expected.push(args);
        try {
            await paint(app);
            await wait();
            assert(app.catalogError);
            assert(expected.length === 1);
            app.element.querySelector('[data-action="retry-catalog"]').click();
            await wait(80);
            assert(!app.catalogError);
            assert(app.available.some((x) => x.uuid === "Item.retry-catalog"));
        } finally {
            console.error = log;
        }
    });
    await run("browsing tabs and details performs no Actor writes", async () => {
        const app = appFor();
        feat(app.actor, "Item.read-only");
        let writes = 0;
        const old = app.actor.update;
        app.actor.update = async (...args) => {
            writes++;
            return old.apply(app.actor, args);
        };
        await paint(app);
        await wait();
        app.activateTab("abilities");
        await wait();
        app.activateTab("profiles");
        await wait();
        app.activateTab("apparitions");
        app.element.querySelector("details[data-detail-key]").open = true;
        await wait(80);
        equal(writes, 0);
    });

    await run("palette follows PF2e character-sheet tokens", async () => {
        const app = appFor();
        await paint(app);
        const root = app.element;
        for (const [key, value] of Object.entries({
            "--bg": "#f8f4f1",
            "--text-dark": "#1c1c1c",
            "--primary": "#5e0000",
            "--secondary": "#171f69",
            "--text-light": "#f5efe0",
        }))
            root.style.setProperty(key, value);
        const body = root.querySelector(".apparition-manager"),
            tab = root.querySelector('[aria-selected="true"]');
        equal(getComputedStyle(body).backgroundColor, "rgb(248, 244, 241)");
        equal(getComputedStyle(body).color, "rgb(28, 28, 28)");
        equal(getComputedStyle(tab).backgroundColor, "rgb(94, 0, 0)");
        equal(getComputedStyle(tab).color, "rgb(245, 239, 224)");
    });
    await run("outer dark mode does not replace the character sheet palette", async () => {
        const app = appFor();
        await paint(app);
        const root = app.element;
        root.style.setProperty("--bg", "#f8f4f1");
        root.style.setProperty("--text-dark", "#1c1c1c");
        const body = root.querySelector(".apparition-manager");
        const before = getComputedStyle(body).backgroundColor;
        root.classList.add("theme-dark");
        equal(getComputedStyle(body).backgroundColor, before);
    });
    await run("custom PF2e palette variables propagate without reopening", async () => {
        const app = appFor();
        await paint(app);
        const root = app.element;
        root.style.setProperty("--bg", "#302820");
        root.style.setProperty("--text-dark", "#f5efe0");
        root.style.setProperty("--primary", "#693228");
        equal(getComputedStyle(root.querySelector(".apparition-manager")).backgroundColor, "rgb(48, 40, 32)");
        equal(getComputedStyle(root.querySelector('[aria-selected="true"]')).backgroundColor, "rgb(105, 50, 40)");
    });

    const primaryPair = (app) => {
        feat(app.actor, "Item.primary-a", "Item.vessel-a");
        feat(app.actor, "Item.primary-b", "Item.vessel-b");
        for (const key of ["Item.vessel-a", "Item.vessel-b"])
            add(app.actor, {
                type: "spell",
                name: key,
                _stats: { compendiumSource: key },
                flags: { "pf2e-dailies-apparition-fix": { identifier: "animist-focus" } },
            });
    };
    await run("primary apparition has a full-card highlight and pressed star", async () => {
        const app = appFor();
        primaryPair(app);
        await core.setPrimaryVessel(app.actor, "Item.primary-a", true);
        await paint(app);
        const marked = app.element.querySelector(".am-card--primary"),
            normal = app.element.querySelector(".am-card--bonded:not(.am-card--primary)");
        assert(marked && normal);
        equal(marked.dataset.primary, "true");
        assert(marked.textContent.includes("Основное"));
        equal(marked.querySelector('[data-action="toggle-primary"]').getAttribute("aria-pressed"), "true");
        assert(getComputedStyle(marked).backgroundColor !== getComputedStyle(normal).backgroundColor);
        assert(getComputedStyle(marked).boxShadow !== "none");
    });
    await run("highlight follows real primary changes and disappears when unset", async () => {
        const app = appFor();
        primaryPair(app);
        await core.setPrimaryVessel(app.actor, "Item.primary-a", true);
        await paint(app);
        await core.setPrimaryVessel(app.actor, "Item.primary-b", true);
        await paint(app);
        equal(app.element.querySelector('.am-card--primary [data-action="toggle-primary"]').dataset.key, "Item.primary-b");
        await core.setPrimaryVessel(app.actor, "Item.primary-b", false);
        await paint(app);
        equal(app.element.querySelectorAll(".am-card--primary").length, 0);
    });
    await run("permanent choice alone is not styled as a primary apparition", async () => {
        const app = appFor();
        feat(app.actor, "Item.permanent-only");
        const context = await app._prepareContext({});
        context.bonded[0].isPermanent = true;
        context.bonded[0].vesselIsPrimary = false;
        const root = document.createElement("div");
        root.innerHTML = template(context);
        assert(root.textContent.includes("Постоянное"));
        equal(root.querySelectorAll(".am-card--primary").length, 0);
    });
    await run("template can highlight two primary apparitions independently", async () => {
        const app = appFor();
        primaryPair(app);
        const context = await app._prepareContext({});
        for (const row of context.bonded) row.vesselIsPrimary = true;
        const root = document.createElement("div");
        root.innerHTML = template(context);
        equal(root.querySelectorAll(".am-card--primary").length, 2);
    });
    await run("compact header retains the complete rules and remembers disclosure", async () => {
        const app = appFor();
        await paint(app);
        const rules = app.element.querySelector('[data-ui-section="attunement-rules"]');
        assert(rules && !rules.open);
        assert(rules.textContent.includes("дополнительные явления не блокируются"));
        rules.querySelector("summary").click();
        await wait();
        assert(app.element.querySelector('[data-ui-section="attunement-rules"]').open);
        await paint(app);
        assert(app.element.querySelector('[data-ui-section="attunement-rules"]').open);
    });
    await run("compact cards retain 44px controls and separate summary text from actions", async () => {
        const app = appFor();
        primaryPair(app);
        await core.setPrimaryVessel(app.actor, "Item.primary-a", true);
        await paint(app);
        await wait();
        app.element.style.width = "820px";
        app.element.style.height = "720px";
        const card = app.element.querySelector(".am-card--primary"),
            summary = card.querySelector("summary"),
            actions = card.querySelector(".am-card-actions");
        assert(card.getBoundingClientRect().height < 170, `card too tall: ${card.getBoundingClientRect().height}`);
        for (const button of actions.querySelectorAll("button")) {
            const box = button.getBoundingClientRect();
            assert(box.width >= 44 && box.height >= 44);
            assert(button.title || button.getAttribute("aria-label"));
        }
        const range = document.createRange();
        range.selectNodeContents(summary);
        const text = range.getBoundingClientRect();
        assert(text.right <= actions.getBoundingClientRect().left - 3, `summary text overlaps actions: ${text.right}`);
    });
    await run("compact bind and unbind controls remain named native buttons", async () => {
        const app = appFor();
        feat(app.actor, "Item.compact-bonded");
        app.available = [data.summarizeApparition(feat(actor(), "Item.compact-available"))];
        app.availableLoading = false;
        app.started = true;
        await paint(app);
        for (const action of ["bond", "unbond"]) {
            const button = app.element.querySelector(`[data-action="${action}"]`);
            assert(button instanceof HTMLButtonElement);
            assert(button.getAttribute("aria-label"));
            assert(button.querySelector("svg"));
        }
    });

    await run("compact typography is scoped and preserves usable controls", async () => {
        const app = appFor();
        primaryPair(app);
        await core.setPrimaryVessel(app.actor, "Item.primary-a", true);
        await paint(app);
        const manager = app.element.matches(".apparition-manager") ? app.element : app.element.querySelector(".apparition-manager");
        equal(getComputedStyle(manager).fontSize, "14px");
        equal(getComputedStyle(manager.querySelector(".am-card-name > strong")).fontSize, "15px");
        for (const selector of [".am-badge", ".am-lores", ".am-count", ".am-eyebrow"]) {
            const node = manager.querySelector(selector);
            assert(node, selector);
            equal(getComputedStyle(node).fontSize, "12px");
        }
        for (const button of manager.querySelectorAll(".am-card-actions button")) {
            const box = button.getBoundingClientRect();
            assert(box.width >= 44 && box.height >= 44);
        }
    });

    App.renderer = null;
    globalThis.fromUuid = originalRead;
    game.i18n.localize = originalLocalize;
    game.i18n.format = originalFormat;
}
