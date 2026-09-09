/* standard-extras.js — owns size-chart unit localization. custom.size_table is
   one market-global metafield (headers localized, cm values). On imperial
   locales this converts the rendered chart client-side: headers translated
   via the map below, cm values -> inches at 1 decimal.
   Chart-WIDE cm decision: a chart is cm when any header says "cm" OR its
   bust/hip column starts above 60 (a 60in bust does not exist in practice;
   cm charts sit at 80-130) — same safe heuristic as size-recommendation.
   A chart already in inches is left untouched. Pure conversion, no new claims. */
(function () {
  var dialog = document.querySelector('#size-chart-dialog[data-chart-units="imperial"]');
  if (!dialog) return;

  var HEADERS = [
    [/størrelse/i, 'Size'], [/^str\.?$/i, 'Size'],
    [/bryst/i, 'Bust'], [/talje/i, 'Waist'], [/hofte(r)?/i, 'Hip'],
    [/længde/i, 'Length'], [/skulder/i, 'Shoulder'], [/ærme(længde)?/i, 'Sleeve'],
    [/bredde/i, 'Width']
  ];
  var MEASURE = /bryst|talje|hofte|længde|skulder|ærme|bredde|bust|waist|hip|length|shoulder|sleeve|width|chest/i;
  var SIZEISH = /størrelse|^str\.?|size|\b(us|uk|eu)\b/i;

  function translateHeader(text) {
    var out = text;
    HEADERS.forEach(function (m) { out = out.replace(m[0], m[1]); });
    return out.replace(/\(\s*cm\s*\)/i, '(in)').replace(/\bcm\b/i, 'in');
  }
  function convertCell(text) {
    /* converts every number in the cell (ranges like "80-84" both), 1 decimal */
    return text.replace(/\d+(?:[.,]\d+)?/g, function (n) {
      var v = parseFloat(n.replace(',', '.'));
      return (Math.round((v / 2.54) * 10) / 10).toString();
    });
  }

  dialog.querySelectorAll('table').forEach(function (table) {
    var rows = table.querySelectorAll('tr');
    if (rows.length < 2) return;
    var heads = rows[0].querySelectorAll('th, td');
    var isCm = false, measureCols = [];
    heads.forEach(function (c, i) {
      var h = c.textContent;
      if (/cm/i.test(h)) isCm = true;
      if (MEASURE.test(h) && !SIZEISH.test(h.replace(MEASURE, ''))) measureCols.push(i);
    });
    if (!isCm && measureCols.length) {
      /* magnitude check on the first measure column's first data value */
      var firstCells = rows[1].querySelectorAll('td, th');
      var probe = firstCells[measureCols[0]];
      var num = probe && probe.textContent.match(/\d+(?:[.,]\d+)?/);
      if (num && parseFloat(num[0].replace(',', '.')) > 60) isCm = true;
    }
    heads.forEach(function (c) { c.textContent = translateHeader(c.textContent); });
    if (!isCm) return;
    for (var r = 1; r < rows.length; r++) {
      var cells = rows[r].querySelectorAll('td, th');
      measureCols.forEach(function (i) {
        if (cells[i]) cells[i].textContent = convertCell(cells[i].textContent);
      });
    }
    table.setAttribute('data-units-converted', 'in');
  });

  /* the unit note under the table is a market-global template setting.
     Once anything was converted, replace it with the localized converted-note. */
  if (dialog.querySelector('[data-units-converted]')) {
    var note = dialog.querySelector('[data-size-unit-note]');
    if (note && dialog.dataset.convertedNote) note.textContent = dialog.dataset.convertedNote;
  }
})();
