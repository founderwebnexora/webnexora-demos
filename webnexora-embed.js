/**
 * webnexora-embed.js
 *
 * Drop-in booking/contact form for a Webnexora client website.
 *
 * Each site declares only who it is; everything about the form — which of the
 * four types to render, what to call the resource, whether to ask party size,
 * opening hours, prices — is read from that client's row at runtime. Change
 * business_config in the dashboard and every site updates without a redeploy.
 *
 *   <div id="webnexora-form"></div>
 *   <script>
 *     window.WEBNEXORA = { client: 'multi-cusine-001' };
 *   </script>
 *   <script src="webnexora-embed.js" defer></script>
 *
 * Placement — pick whichever suits the page, checked in this order:
 *   replace  CSS selector; swaps that element out for the live form. Use it to
 *            retire a site's existing static/demo form without touching markup.
 *   appendTo CSS selector; adds the form inside that section, keeping whatever
 *            is already there (address blocks, opening hours, and so on).
 *   mount    CSS selector for an empty container the form takes over.
 *
 * Options (all optional except `client`):
 *   client   slug from public.clients.slug            (required)
 *   mount    CSS selector for the container           (default '#webnexora-form')
 *   show     'auto' | 'booking' | 'contact'           (default 'auto')
 *   accent   CSS colour for buttons/highlights        (default '#2F6FED')
 *   title    heading text, '' to hide                 (default derived from form type)
 *   dark     true to use the dark palette             (default: follows the page)
 */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://jvkvxpdzrmnyabmfkofe.supabase.co';
  var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2a3Z4cGR6cm1ueWFibWZrb2ZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczMTA2MDgsImV4cCI6MjEwMjg4NjYwOH0.QzMFQbRHLu9Ok-D2QdGTbv_A4asgFdencKipQELyEb8';
  var SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';

  var opts = window.WEBNEXORA || {};
  if (!opts.client) {
    console.error('[webnexora] window.WEBNEXORA.client (the client slug) is required.');
    return;
  }

  /* ---------------- tiny DOM helpers ---------------- */

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    });
    [].concat(kids || []).forEach(function (c) {
      if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  function field(labelText, input, hint) {
    return el('label', { class: 'wx-field' }, [
      el('span', { class: 'wx-label', text: labelText }),
      input,
      hint ? el('span', { class: 'wx-hint', text: hint }) : null
    ]);
  }

  function debounce(fn, wait) {
    var t;
    return function () {
      var a = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(null, a); }, wait || 300);
    };
  }

  function money(amount, currency) {
    if (amount == null || amount === '') return '';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'INR' }).format(amount);
    } catch (e) {
      return amount + ' ' + (currency || '');
    }
  }

  /* Local wall-clock in the business's timezone -> true UTC instant.
     The visitor may be sitting in a different timezone than the venue, so
     never let the browser's own offset decide what "7pm" means.

     Reads the zone offset off Intl rather than round-tripping through
     Date.toLocaleString(): parsing a localised string re-interprets it in the
     *browser's* zone, which silently cancels out and yields the wall clock as
     if it were UTC whenever the two zones share an offset. */
  function localToISO(dateStr, timeStr, tz) {
    if (!dateStr || !timeStr) return null;
    var dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    function offsetAt(d) {
      var p = {};
      dtf.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
      return Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second) - d.getTime();
    }
    var guess = new Date(dateStr + 'T' + timeStr + ':00Z');
    var approx = new Date(guess.getTime() - offsetAt(guess));
    // Second pass so a DST transition between the two instants resolves.
    return new Date(guess.getTime() - offsetAt(approx)).toISOString();
  }

  function timeInTZ(iso, tz) {
    return new Date(iso).toLocaleTimeString('en-US', {
      timeZone: tz, hour: 'numeric', minute: '2-digit'
    });
  }

  function todayInTZ(tz) {
    return new Date().toLocaleDateString('en-CA', { timeZone: tz });
  }

  /* ---------------- styles ---------------- */

  function injectStyles(accent) {
    if (document.getElementById('wx-styles')) return;
    var css = [
      '.wx-form{--wx-accent:' + accent + ';--wx-bg:#fff;--wx-fg:#1B2532;--wx-muted:#6B7A90;--wx-line:#DDE3EC;--wx-soft:#F4F7FB;',
      'font-family:inherit;color:var(--wx-fg);background:var(--wx-bg);border:1px solid var(--wx-line);',
      'border-radius:14px;padding:22px;max-width:520px;box-sizing:border-box;text-align:left;}',
      '.wx-form.wx-dark{--wx-bg:#141922;--wx-fg:#F2F5FA;--wx-muted:#9AA7B8;--wx-line:#2C3543;--wx-soft:#1C232E;}',
      '.wx-form *{box-sizing:border-box;}',
      '.wx-title{font-size:1.15rem;font-weight:600;margin:0 0 4px;}',
      '.wx-sub{font-size:.85rem;color:var(--wx-muted);margin:0 0 18px;}',
      '.wx-field{display:block;margin-bottom:14px;}',
      '.wx-label{display:block;font-size:.72rem;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--wx-muted);margin-bottom:6px;}',
      '.wx-hint{display:block;font-size:.75rem;color:var(--wx-muted);margin-top:5px;}',
      '.wx-form input,.wx-form select,.wx-form textarea{width:100%;padding:11px 12px;font:inherit;font-size:.92rem;',
      'color:var(--wx-fg);background:var(--wx-soft);border:1px solid var(--wx-line);border-radius:8px;}',
      '.wx-form textarea{resize:vertical;min-height:88px;}',
      '.wx-form input:focus,.wx-form select:focus,.wx-form textarea:focus{outline:2px solid var(--wx-accent);outline-offset:1px;border-color:transparent;}',
      '.wx-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;}',
      '.wx-slots{display:flex;flex-wrap:wrap;gap:8px;}',
      '.wx-slot{padding:9px 13px;font:inherit;font-size:.85rem;background:var(--wx-soft);color:var(--wx-fg);',
      'border:1px solid var(--wx-line);border-radius:8px;cursor:pointer;}',
      '.wx-slot:hover{border-color:var(--wx-accent);}',
      '.wx-slot[aria-pressed="true"]{background:var(--wx-accent);color:#fff;border-color:var(--wx-accent);}',
      '.wx-tiers{display:grid;gap:10px;}',
      '.wx-tier{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:13px 15px;',
      'background:var(--wx-soft);border:1px solid var(--wx-line);border-radius:10px;cursor:pointer;text-align:left;font:inherit;color:var(--wx-fg);}',
      '.wx-tier:hover{border-color:var(--wx-accent);}',
      '.wx-tier[aria-pressed="true"]{border-color:var(--wx-accent);box-shadow:inset 0 0 0 1px var(--wx-accent);}',
      '.wx-tier[disabled]{opacity:.45;cursor:not-allowed;}',
      '.wx-tier-name{font-weight:600;font-size:.9rem;}',
      '.wx-tier-price{font-variant-numeric:tabular-nums;font-weight:600;font-size:.9rem;}',
      '.wx-note{font-size:.82rem;margin:10px 0;color:var(--wx-muted);}',
      '.wx-note.wx-ok{color:#1E7F4F;}.wx-note.wx-bad{color:#C0362E;}',
      '.wx-dark .wx-note.wx-ok{color:#5FD3A0;}.wx-dark .wx-note.wx-bad{color:#FF8B80;}',
      '.wx-price{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;margin:4px 0 16px;',
      'background:var(--wx-soft);border:1px solid var(--wx-line);border-radius:10px;font-weight:600;font-size:.95rem;}',
      '.wx-price small{display:block;font-weight:400;font-size:.72rem;color:var(--wx-muted);margin-top:2px;}',
      '.wx-submit{width:100%;padding:13px;font:inherit;font-size:.95rem;font-weight:600;color:#fff;',
      'background:var(--wx-accent);border:0;border-radius:9px;cursor:pointer;}',
      '.wx-submit:hover{filter:brightness(1.08);}',
      '.wx-submit[disabled]{opacity:.55;cursor:not-allowed;}',
      '.wx-status{font-size:.85rem;margin-top:12px;}',
      '.wx-status.wx-bad{color:#C0362E;}.wx-status.wx-ok{color:#1E7F4F;}',
      '.wx-dark .wx-status.wx-ok{color:#5FD3A0;}.wx-dark .wx-status.wx-bad{color:#FF8B80;}',
      '.wx-done{text-align:center;padding:26px 10px;}',
      '.wx-done-mark{width:44px;height:44px;border-radius:50%;background:var(--wx-accent);color:#fff;',
      'display:flex;align-items:center;justify-content:center;font-size:1.4rem;margin:0 auto 14px;}',
      '@media (max-width:520px){.wx-row{grid-template-columns:1fr;}}'
    ].join('');
    document.head.appendChild(el('style', { id: 'wx-styles', text: css }));
  }

  /* ---------------- supabase bootstrap ---------------- */

  function loadSupabase() {
    return new Promise(function (resolve, reject) {
      if (window.supabase && window.supabase.createClient) return resolve();
      var s = document.createElement('script');
      s.src = SUPABASE_CDN;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load the booking library.')); };
      document.head.appendChild(s);
    });
  }

  function makeApi(sb) {
    function rpc(name, args) {
      return sb.rpc(name, args).then(function (r) {
        if (r.error) throw r.error;
        return r.data;
      });
    }
    return {
      publicConfig: function (slug) { return rpc('get_client_public_config', { p_slug: slug }); },
      pools: function (clientId) { return rpc('get_client_bookable_pools', { p_client_id: clientId, p_item_type: null }); },
      formConfig: function (itemId) { return rpc('get_booking_form_config', { p_item_id: itemId }); },
      slots: function (itemId, date, qty) { return rpc('get_available_slots', { p_item_id: itemId, p_date: date, p_quantity: qty }); },
      rangeOk: function (itemId, s, e, qty) { return rpc('check_range_availability', { p_item_id: itemId, p_starts_at: s, p_ends_at: e, p_quantity: qty }); },
      tier: function (itemId, s, mins, qty) {
        return rpc('check_duration_tier', { p_item_id: itemId, p_starts_at: s, p_minutes: mins, p_quantity: qty })
          .then(function (d) { return Array.isArray(d) ? d[0] : d; });
      },
      price: function (itemId, s, e, mins, qty) {
        return rpc('calculate_booking_price', { p_item_id: itemId, p_starts_at: s, p_ends_at: e, p_duration_minutes: mins, p_quantity: qty });
      },
      submitContact: function (a) {
        return rpc('submit_contact_request', {
          p_client_id: a.clientId, p_name: a.name, p_email: a.email,
          p_phone: a.phone, p_custom_fields: a.message ? { message: a.message } : {}
        });
      },
      submitBooking: function (a) {
        // p_amount is deliberately omitted: the server prices every public
        // booking itself, and ignores a client-supplied amount anyway.
        return rpc('submit_booking_request', {
          p_client_id: a.clientId, p_customer_name: a.name, p_bookable_item_id: a.itemId,
          p_starts_at: a.startsAt, p_ends_at: a.endsAt,
          p_customer_email: a.email || null, p_customer_phone: a.phone,
          p_assigned_unit_id: null, p_status: 'pending', p_custom_fields: a.customFields || {},
          p_source: 'website', p_party_size: a.partySize == null ? null : a.partySize,
          p_quantity: a.quantity == null ? 1 : a.quantity
        });
      }
    };
  }

  /* ---------------- shared form pieces ---------------- */

  function contactBlock(state) {
    var name = el('input', { type: 'text', required: 'required', autocomplete: 'name' });
    var email = el('input', { type: 'email', autocomplete: 'email' });
    var phone = el('input', { type: 'tel', required: 'required', autocomplete: 'tel' });
    var emailRequired = state.cfg.require_email;
    if (emailRequired) email.setAttribute('required', 'required');
    return {
      name: name, email: email, phone: phone,
      nodes: [
        field('Name *', name),
        el('div', { class: 'wx-row' }, [
          field('Phone *', phone),
          field('Email' + (emailRequired ? ' *' : ''), email)
        ])
      ]
    };
  }

  function successPanel(root, accentTitle, msg) {
    root.innerHTML = '';
    root.appendChild(el('div', { class: 'wx-done' }, [
      el('div', { class: 'wx-done-mark', text: '✓' }),
      el('div', { class: 'wx-title', text: accentTitle }),
      el('p', { class: 'wx-sub', text: msg })
    ]));
  }

  /* Resource picker: a dropdown only when there is a genuine choice.
     One doctor, one dining room, one bay -> just name it. */
  function resourcePicker(state, onChange) {
    var pools = state.pools;
    var label = (state.cfg.booking.resource_label) || 'Option';
    if (pools.length === 0) return { node: null, get: function () { return null; } };

    if (pools.length === 1) {
      state.itemId = pools[0].id;
      return {
        node: field(label, el('input', { type: 'text', value: pools[0].name, disabled: 'disabled' })),
        get: function () { return pools[0].id; }
      };
    }

    var sel = el('select', { required: 'required' });
    sel.appendChild(el('option', { value: '', text: 'Choose a ' + label.toLowerCase() + '…' }));
    pools.forEach(function (p) {
      sel.appendChild(el('option', { value: p.id, text: p.name }));
    });
    sel.addEventListener('change', function () {
      state.itemId = sel.value || null;
      onChange();
    });
    return { node: field(label + ' *', sel), get: function () { return sel.value || null; } };
  }

  /* ---------------- form 1: contact ---------------- */

  function renderContact(root, state, api) {
    var f = el('form', { class: 'wx-form' + (state.dark ? ' wx-dark' : '') });
    var c = contactBlock(state);
    var msg = el('textarea', { placeholder: 'How can we help?' });
    var status = el('div', { class: 'wx-status' });
    var btn = el('button', { type: 'submit', class: 'wx-submit', text: 'Send enquiry' });

    if (state.title !== '') f.appendChild(el('h3', { class: 'wx-title', text: state.title || 'Get in touch' }));
    f.appendChild(el('p', { class: 'wx-sub', text: 'We’ll get back to you shortly.' }));
    c.nodes.forEach(function (n) { f.appendChild(n); });
    f.appendChild(field('Message', msg));
    f.appendChild(btn);
    f.appendChild(status);

    f.addEventListener('submit', function (e) {
      e.preventDefault();
      status.className = 'wx-status';
      status.textContent = 'Sending…';
      btn.disabled = true;
      api.submitContact({
        clientId: state.cfg.id,
        name: c.name.value.trim(),
        email: c.email.value.trim() || null,
        phone: c.phone.value.trim(),
        message: msg.value.trim()
      }).then(function () {
        successPanel(root, 'Enquiry sent', 'Thanks — ' + state.cfg.name + ' will be in touch soon.');
      }).catch(function (err) {
        btn.disabled = false;
        status.className = 'wx-status wx-bad';
        status.textContent = err.message || 'Could not send. Please try again.';
      });
    });

    root.innerHTML = '';
    root.appendChild(f);
  }

  /* ---------------- forms 2-4: booking ---------------- */

  function renderBooking(root, state, api) {
    var type = state.cfg.booking.form_type;
    var tz = state.cfg.timezone;
    var askParty = state.cfg.booking.ask_party_size;

    var f = el('form', { class: 'wx-form' + (state.dark ? ' wx-dark' : '') });
    var c = contactBlock(state);
    var status = el('div', { class: 'wx-status' });
    var btn = el('button', { type: 'submit', class: 'wx-submit', text: 'Request booking' });

    var defaultTitle = askParty ? 'Reserve a table'
      : type === 'range' ? 'Book your dates'
        : type === 'duration_tiers' ? 'Book a slot' : 'Book an appointment';
    if (state.title !== '') f.appendChild(el('h3', { class: 'wx-title', text: state.title || defaultTitle }));
    f.appendChild(el('p', { class: 'wx-sub', text: state.cfg.name }));
    c.nodes.forEach(function (n) { f.appendChild(n); });

    /* party size doubles as the capacity unit — a table for six holds six seats */
    var partyInput = el('input', { type: 'number', min: '1', step: '1', value: '2', required: 'required' });
    var startDate = el('input', { type: 'date', required: 'required', min: todayInTZ(tz) });
    var startTime = el('input', { type: 'time', value: '09:00', required: 'required' });
    var endDate = el('input', { type: 'date', required: 'required', min: todayInTZ(tz) });
    var endTime = el('input', { type: 'time', value: '09:00', required: 'required' });
    var slotWrap = el('div', { class: 'wx-slots', text: 'Pick a date to see available times.' });
    var tierWrap = el('div', { class: 'wx-tiers' });
    var note = el('div', { class: 'wx-note' });
    var priceBox = el('div', { class: 'wx-price' });
    priceBox.style.display = 'none';

    var chosenSlot = null;
    var chosenTier = null;

    function qty() {
      if (!askParty) return 1;
      var n = parseInt(partyInput.value, 10);
      return n > 0 ? n : 1;
    }

    function showPrice(amount, caption) {
      if (amount == null) { priceBox.style.display = 'none'; return; }
      priceBox.innerHTML = '';
      priceBox.appendChild(el('span', { text: 'Estimated total' }));
      priceBox.appendChild(el('span', {}, [
        document.createTextNode(money(amount, state.currency)),
        caption ? el('small', { text: caption }) : null
      ]));
      priceBox.style.display = 'flex';
    }

    var picker = resourcePicker(state, function () { refresh(); });
    if (picker.node) f.appendChild(picker.node);
    if (askParty) f.appendChild(field('Party size *', partyInput, 'How many people are dining'));

    if (type === 'slots') {
      f.appendChild(field('Date *', startDate));
      f.appendChild(field('Available times *', slotWrap));
    } else if (type === 'range') {
      f.appendChild(el('div', { class: 'wx-row' }, [field('Start date *', startDate), field('Start time *', startTime)]));
      f.appendChild(el('div', { class: 'wx-row' }, [field('End date *', endDate), field('End time *', endTime)]));
      f.appendChild(note);
    } else if (type === 'duration_tiers') {
      f.appendChild(el('div', { class: 'wx-row' }, [field('Start date *', startDate), field('Start time *', startTime)]));
      f.appendChild(field('Choose a duration *', tierWrap));
    }

    f.appendChild(priceBox);
    f.appendChild(btn);
    f.appendChild(status);

    /* ---- per-type refresh ---- */

    function refreshSlots() {
      chosenSlot = null;
      showPrice(null);
      if (!state.itemId || !startDate.value) return;
      slotWrap.textContent = 'Loading times…';
      api.slots(state.itemId, startDate.value, qty()).then(function (rows) {
        slotWrap.innerHTML = '';
        if (!rows || !rows.length) {
          slotWrap.textContent = askParty
            ? 'No table for ' + qty() + ' on this date — try a smaller party or another day.'
            : 'No available times on this date.';
          return;
        }
        rows.forEach(function (s) {
          var b = el('button', {
            type: 'button', class: 'wx-slot', 'aria-pressed': 'false',
            text: timeInTZ(s.slot_start, tz),
            title: askParty && s.spots_available != null ? s.spots_available + ' seats free' : null
          });
          b.addEventListener('click', function () {
            slotWrap.querySelectorAll('.wx-slot').forEach(function (o) { o.setAttribute('aria-pressed', 'false'); });
            b.setAttribute('aria-pressed', 'true');
            chosenSlot = s;
            priceForRange(s.slot_start, s.slot_end);
          });
          slotWrap.appendChild(b);
        });
      }).catch(function (err) {
        slotWrap.textContent = err.message || 'Could not load times.';
      });
    }

    function refreshRange() {
      showPrice(null);
      if (!state.itemId || !startDate.value || !endDate.value) return;
      var s = localToISO(startDate.value, startTime.value, tz);
      var e = localToISO(endDate.value, endTime.value, tz);
      if (!s || !e) return;
      if (new Date(e) <= new Date(s)) {
        note.className = 'wx-note wx-bad';
        note.textContent = 'End must be after start.';
        return;
      }
      note.className = 'wx-note';
      note.textContent = 'Checking availability…';
      api.rangeOk(state.itemId, s, e, qty()).then(function (ok) {
        note.className = 'wx-note ' + (ok ? 'wx-ok' : 'wx-bad');
        note.textContent = ok ? 'Available for these dates.' : 'Not available for these dates.';
        if (!ok) return null;
        return priceForRange(s, e);
      }).catch(function (err) {
        note.className = 'wx-note wx-bad';
        note.textContent = err.message || 'Could not check availability.';
      });
    }

    function refreshTiers() {
      chosenTier = null;
      showPrice(null);
      tierWrap.innerHTML = '';
      if (!state.itemId || !startDate.value) return;
      var tiers = (state.itemCfg && state.itemCfg.duration_tiers) || [];
      if (!tiers.length) { tierWrap.textContent = 'No durations configured.'; return; }
      var s = localToISO(startDate.value, startTime.value, tz);

      tiers.forEach(function (t) {
        var card = el('button', { type: 'button', class: 'wx-tier', 'aria-pressed': 'false', disabled: 'disabled' }, [
          el('span', { class: 'wx-tier-name', text: t.label || (t.minutes + ' min') }),
          el('span', { class: 'wx-tier-price', text: '…' })
        ]);
        tierWrap.appendChild(card);

        api.tier(state.itemId, s, t.minutes, qty()).then(function (res) {
          var priceEl = card.querySelector('.wx-tier-price');
          if (!res || res.available === false) {
            priceEl.textContent = 'Unavailable';
            return;
          }
          priceEl.textContent = money(res.price, state.currency);
          card.removeAttribute('disabled');
          card.addEventListener('click', function () {
            tierWrap.querySelectorAll('.wx-tier').forEach(function (o) { o.setAttribute('aria-pressed', 'false'); });
            card.setAttribute('aria-pressed', 'true');
            chosenTier = { minutes: t.minutes, endsAt: res.ends_at, price: res.price };
            showPrice(res.price, t.label || null);
          });
        }).catch(function () {
          card.querySelector('.wx-tier-price').textContent = 'Unavailable';
        });
      });
    }

    function priceForRange(startISO, endISO) {
      var mins = Math.round((new Date(endISO) - new Date(startISO)) / 60000);
      return api.price(state.itemId, startISO, endISO, mins, qty()).then(function (p) {
        showPrice(p);
      }).catch(function () { showPrice(null); });
    }

    function refresh() {
      // Item config carries the tier menu, so reload it whenever the pick changes.
      if (type === 'duration_tiers' && state.itemId) {
        api.formConfig(state.itemId).then(function (cfg) {
          state.itemCfg = cfg;
          refreshTiers();
        }).catch(function () { refreshTiers(); });
        return;
      }
      if (type === 'slots') refreshSlots();
      else if (type === 'range') refreshRange();
    }

    var deb = debounce(refresh, 280);
    [startDate, startTime, endDate, endTime].forEach(function (i) { i.addEventListener('change', deb); });
    if (askParty) partyInput.addEventListener('change', deb);
    if (type === 'range') {
      // keep the end date from trailing the start date
      startDate.addEventListener('change', function () {
        endDate.min = startDate.value;
        if (!endDate.value || endDate.value < startDate.value) endDate.value = startDate.value;
      });
    }

    f.addEventListener('submit', function (e) {
      e.preventDefault();
      status.className = 'wx-status';

      if (!state.itemId) {
        status.className = 'wx-status wx-bad';
        status.textContent = 'Please choose a ' + ((state.cfg.booking.resource_label || 'option').toLowerCase()) + '.';
        return;
      }

      var startsAt, endsAt;
      if (type === 'slots') {
        if (!chosenSlot) {
          status.className = 'wx-status wx-bad';
          status.textContent = 'Please pick a time.';
          return;
        }
        startsAt = chosenSlot.slot_start;
        endsAt = chosenSlot.slot_end;
      } else if (type === 'range') {
        startsAt = localToISO(startDate.value, startTime.value, tz);
        endsAt = localToISO(endDate.value, endTime.value, tz);
        if (new Date(endsAt) <= new Date(startsAt)) {
          status.className = 'wx-status wx-bad';
          status.textContent = 'End must be after start.';
          return;
        }
      } else {
        if (!chosenTier) {
          status.className = 'wx-status wx-bad';
          status.textContent = 'Please choose a duration.';
          return;
        }
        startsAt = localToISO(startDate.value, startTime.value, tz);
        endsAt = chosenTier.endsAt;
      }

      btn.disabled = true;
      status.textContent = 'Sending request…';

      api.submitBooking({
        clientId: state.cfg.id,
        itemId: state.itemId,
        name: c.name.value.trim(),
        email: c.email.value.trim() || null,
        phone: c.phone.value.trim(),
        startsAt: startsAt,
        endsAt: endsAt,
        partySize: askParty ? qty() : null,
        quantity: qty()
      }).then(function () {
        successPanel(root, 'Request received',
          state.cfg.name + ' will confirm your booking shortly. You’ll hear from us on the number you gave.');
      }).catch(function (err) {
        btn.disabled = false;
        status.className = 'wx-status wx-bad';
        status.textContent = err.message || 'Could not complete the request. Please try again.';
      });
    });

    root.innerHTML = '';
    root.appendChild(f);
    refresh();
  }

  /* ---------------- boot ---------------- */

  /* Resolve where the form should live. `replace` and `appendTo` let a site
     adopt the form with nothing but the two script tags — no markup surgery,
     and removing the snippet restores the page exactly as it was. */
  function resolveRoot() {
    var target, host;

    if (opts.replace) {
      target = document.querySelector(opts.replace);
      if (target && target.parentNode) {
        host = el('div', { class: 'wx-mount' });
        target.parentNode.replaceChild(host, target);
        return host;
      }
      console.warn('[webnexora] replace target not found:', opts.replace);
    }

    if (opts.appendTo) {
      target = document.querySelector(opts.appendTo);
      if (target) {
        host = el('div', { class: 'wx-mount' });
        host.style.margin = '28px auto 0';
        target.appendChild(host);
        return host;
      }
      console.warn('[webnexora] appendTo target not found:', opts.appendTo);
    }

    return document.querySelector(opts.mount || '#webnexora-form');
  }

  /* Pick the light or dark palette from whatever the form is actually sitting
     on, so it looks native on a dark site without per-site configuration.
     Walks up for the first ancestor with a real (non-transparent) background. */
  function detectDark(node) {
    for (var n = node; n && n !== document.documentElement; n = n.parentElement) {
      var bg = getComputedStyle(n).backgroundColor;
      var m = bg && bg.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
      if (!m) continue;
      if (m[4] !== undefined && parseFloat(m[4]) === 0) continue;   // transparent, keep going
      var lum = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
      return lum < 0.5;
    }
    return false;
  }

  function boot() {
    var root = resolveRoot();
    if (!root) {
      console.error('[webnexora] no place to mount the form. Set replace, appendTo, or mount.');
      return;
    }

    injectStyles(opts.accent || '#2F6FED');
    root.textContent = 'Loading…';

    loadSupabase().then(function () {
      var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      var api = makeApi(sb);

      return api.publicConfig(opts.client).then(function (cfg) {
        if (!cfg) throw new Error('This booking form is not configured yet.');

        var state = {
          cfg: cfg,
          currency: cfg.currency,
          dark: opts.dark != null ? opts.dark : detectDark(root),
          title: opts.title,
          itemId: null,
          itemCfg: null,
          pools: []
        };

        var wantBooking = opts.show === 'booking' ||
          (opts.show !== 'contact' && cfg.modules.reservations && cfg.booking.form_type !== 'none');

        if (!wantBooking) {
          renderContact(root, state, api);
          return;
        }

        return api.pools(cfg.id).then(function (pools) {
          state.pools = pools || [];
          // Reservations on but nothing bookable yet: an enquiry form is far
          // better than an empty picker the visitor cannot use.
          if (!state.pools.length) {
            renderContact(root, state, api);
            return;
          }
          if (state.pools.length === 1) state.itemId = state.pools[0].id;
          renderBooking(root, state, api);
        });
      });
    }).catch(function (err) {
      root.textContent = err.message || 'This form is temporarily unavailable.';
      console.error('[webnexora]', err);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
