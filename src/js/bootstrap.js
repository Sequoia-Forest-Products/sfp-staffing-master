// bootstrap — the only top-level calls that kick the app off. Last in the
// manifest so every function and every shared constant is already in scope.
//
// Shares one global scope with the other files in src/js (see core.js).

// Permissions first, and not awaited. It decides whether the Salaries & Wages
// tab exists and whether Settings shows the Access section, and it re-renders
// itself when it lands — so blocking the roster on it would trade a tab
// appearing a moment late for the whole app appearing a moment late.
loadPermissions();
loadEmailSettings();
loadData();
