/* Pre-Post Theatre Dining: venue filter pills. Each .vrow carries data-cats="theatres comedy ...".
   Photo side alternates over the VISIBLE rows (.is-flip on every second one), so filtering keeps left/right/left/right. */
(function () {
  'use strict';
  var btns = Array.prototype.slice.call(document.querySelectorAll('.vfilter-btn'));
  var rows = Array.prototype.slice.call(document.querySelectorAll('.vrow'));
  var empty = document.querySelector('.vrows-empty');
  if (!btns.length || !rows.length) return;

  function apply(f) {
    var n = 0;
    rows.forEach(function (r) {
      var on = f === 'all' || (' ' + r.getAttribute('data-cats') + ' ').indexOf(' ' + f + ' ') > -1;
      r.hidden = !on;
      if (on) { r.classList.toggle('is-flip', n % 2 === 1); n++; r.classList.add('in-view'); }
    });
    btns.forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-filter') === f ? 'true' : 'false'); });
    if (empty) empty.hidden = n > 0;
  }
  apply('all');
  btns.forEach(function (b) { b.addEventListener('click', function () { apply(b.getAttribute('data-filter')); }); });
})();
