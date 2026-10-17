import js from "@eslint/js";
import globals from "globals";

const foundry = Object.fromEntries(
    ["foundry", "game", "Hooks", "CONFIG", "CONST", "ui", "fromUuid", "fromUuidSync", "Actor", "Item", "Folder", "Macro", "ChatMessage", "canvas", "_loc"].map((name) => [
        name,
        "readonly",
    ]),
);

export default [
    { ignores: ["node_modules/", "dist/"] },
    js.configs.recommended,
    {
        files: ["scripts/**/*.mjs"],
        languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.browser, ...foundry } },
        rules: {
            "no-unused-vars": ["warn", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }],
        },
    },
    {
        files: ["tools/**/*.mjs", "eslint.config.mjs"],
        languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: globals.node },
    },
];
