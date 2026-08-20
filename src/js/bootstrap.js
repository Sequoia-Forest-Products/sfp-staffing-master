// bootstrap — the only top-level calls that kick the app off. Last in the
// manifest so every function and every shared constant is already in scope.
//
// Shares one global scope with the other files in src/js (see core.js).

loadEmailSettings();
loadData();
