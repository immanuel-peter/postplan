// Filters a table's rows as you type. Each <input data-table-search="tableId"> matches rows whose
// data-search-fields text contains every word of the query, case-insensitively. Escape clears it.
(function () {
  "use strict";

  document.querySelectorAll("input[data-table-search]").forEach(function (input) {
    var table = document.getElementById(input.getAttribute("data-table-search"));
    if (!table) return;
    var fields = input.getAttribute("data-search-fields");
    var noMatch = table.querySelector("tbody tr.search-empty");
    var rows = Array.prototype.map.call(table.querySelectorAll("tbody tr:not(.empty-row)"), function (row) {
      var text = Array.prototype.map
        .call(row.querySelectorAll(fields), function (el) {
          return el.textContent;
        })
        .join(" ")
        .toLowerCase();
      return { el: row, text: text };
    });

    function apply() {
      var words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      var shown = 0;
      rows.forEach(function (row) {
        var match = words.every(function (word) {
          return row.text.indexOf(word) !== -1;
        });
        row.el.hidden = !match;
        if (match) shown++;
      });
      table.classList.toggle("is-filtered", words.length > 0);
      if (noMatch) noMatch.hidden = shown > 0;
    }

    input.addEventListener("input", apply);
    input.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && input.value) {
        input.value = "";
        apply();
      }
    });
    if (input.value) apply();
  });
})();
