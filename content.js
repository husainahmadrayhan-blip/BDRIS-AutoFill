
(() => {
  if (window.__BDRIS_AUTOFILL_V33_ACTIVE__) return;
  window.__BDRIS_AUTOFILL_V33_ACTIVE__ = true;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Diagnostic trail: identifies the exact field and timing when BDRIS or
  // another script clears an address value. It does not change any value.
  const geoPrefixes = ["birthPlace", "permAddr", "prsntAddr"];
  const watchedIds = geoPrefixes.flatMap(p => [
    p+"Country", p+"Div", p+"Dist", p+"CityCorpCantOrUpazila",
    p+"PaurasavaOrUnion", p+"WardInCityCorp", p+"Area",
    p+"WardInPaurasavaOrUnion", p+"LocationId", p+"GeolocationId"
  ]);
  const diagnosticSnapshot = label => {
    const out = {};
    watchedIds.forEach(id => { const n = document.getElementById(id); if (n) out[id] = n.value; });
    console.groupCollapsed(`[BDRIS DIAGNOSTIC] ${label} ${new Date().toISOString()}`);
    console.table(out);
    console.trace("diagnostic call location");
    console.groupEnd();
  };
  const diagnosticRoot = document.querySelector("form") || document;
  function manualWarning(title, details) {
    let box = document.getElementById("bdris-autofill-warning");
    if (!box) {
      box = document.createElement("div");
      box.id = "bdris-autofill-warning";
      box.style.cssText = "position:fixed;z-index:2147483647;top:16px;right:16px;max-width:420px;background:#fff3cd;color:#664d03;border:2px solid #ffca2c;border-radius:8px;padding:14px;font:600 14px Arial;box-shadow:0 4px 18px #0004";
      document.body.appendChild(box);
    }
    box.innerHTML = `<div style="font-size:16px;margin-bottom:6px">⚠️ ${title}</div><div>${details}</div><div style="margin-top:8px;font-weight:400">এই field-টি BDRIS page-এ manually select করুন।</div>`;
  }
  new MutationObserver(mutations => {
    for (const m of mutations) {
      const n = m.target?.closest?.("select,input,textarea");
      if (!n || !watchedIds.includes(n.id)) continue;
      if (m.type === "childList" || m.type === "attributes") {
        console.warn("[BDRIS DIAGNOSTIC] DOM changed", n.id, "value=", n.value,
          "options=", n.options?.length ?? "-");
        if (n.value === "" || n.value === "-1") diagnosticSnapshot("field cleared");
      }
    }
  }).observe(diagnosticRoot, {subtree:true, childList:true, attributes:true, attributeFilter:["value","selected","disabled","style"]});
  document.addEventListener("submit", () => diagnosticSnapshot("SUBMIT CAPTURE"), true);
  ["input", "change", "blur"].forEach(type => document.addEventListener(type, e => {
    if (watchedIds.includes(e.target?.id)) {
      console.log("[BDRIS DIAGNOSTIC]", type, e.target.id, "=>", e.target.value);
    }
  }, true));
  console.info("[BDRIS DIAGNOSTIC] active. Watch console for 'DOM changed' and 'field cleared'.");

  const norm = v => String(v ?? "")
    .replace(/[০-৯]/g, d => "০১২৩৪৫৬৭৮৯".indexOf(d))
    .trim().replace(/\s+/g, " ").toLowerCase();
  const numberToken = v => {
    const m = norm(v).match(/(?:^|[^0-9])0*(\d{1,3})(?:[^0-9]|$)/);
    return m ? String(Number(m[1])) : "";
  };

  const bnDigits = s => String(s ?? "").replace(/[০-৯]/g, d => "০১২৩৪৫৬৭৮৯".indexOf(d));
  const enDigits = s => String(s ?? "").replace(/[০-৯]/g, d => "০১২৩৪৫৬৭৮৯".indexOf(d));

  // eVerify/WhatsApp text may contain invisible soft-hyphen, zero-width,
  // BOM or bidi-control characters. Remove only those characters before the
  // value reaches a BDRIS field; visible letters, digits and punctuation stay.
  const cleanIncomingText = value => String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\u00ad\u061c\u070f\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0]/g, "")
    .replace(/\s+/g, " ").trim();
  const cleanIncomingData = value => {
    if (typeof value === "string") return cleanIncomingText(value);
    if (Array.isArray(value)) return value.map(cleanIncomingData);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanIncomingData(v)]));
    }
    return value;
  };

  function el(id) { return document.getElementById(id); }

  function setValue(node, value) {
    if (!node || value === undefined || value === null) return false;
    const proto = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype :
                  node.tagName === "SELECT" ? HTMLSelectElement.prototype :
                  HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(node, String(value));
    else node.value = String(value);

    node.dispatchEvent(new Event("input", {bubbles:true}));
    node.dispatchEvent(new Event("change", {bubbles:true}));
    node.dispatchEvent(new Event("blur", {bubbles:true}));
    return true;
  }

  function fillText(id, value) {
    if (value === undefined || value === null || value === "") return false;
    return setValue(el(id), value);
  }

  async function selectOfficeType(type) {
    const id = type === "BIRTHPLACE" ? "officeBirthplace" :
               type === "PERMANENT" ? "officePermanent" : "";
    if (!id) return true;
    const radio = document.getElementById(id);
    if (!radio) {
      manualWarning("Address type পাওয়া যায়নি", `${id} radio page-এ নেই`);
      return false;
    }
    if (!radio.checked) radio.click();
    radio.checked = true;
    radio.dispatchEvent(new Event("input", {bubbles:true}));
    radio.dispatchEvent(new Event("change", {bubbles:true}));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const current = document.getElementById(id);
      if (current?.checked) {
        console.log("[BDRIS AutoFill] office address selected before fill:", id, radio.value);
        return true;
      }
      await sleep(100);
    }
    manualWarning("Address type select হয়নি", id);
    return false;
  }

  function findOption(select, value) {
    if (!select || value === undefined || value === null || value === "") return null;

    const wanted = norm(value);
    const wantedUpper = norm(value).toUpperCase();

    const options = [...select.options];

    // Exact value first.
    let found = options.find(o => norm(o.value) === wanted);
    if (found) return found;

    // Exact visible text / BDRIS data attributes.
    found = options.find(o => norm(o.textContent) === wanted);
    if (found) return found;

    found = options.find(o => norm(o.dataset.nameBn) === wanted);
    if (found) return found;

    found = options.find(o => norm(o.dataset.nameEn || "").toUpperCase() === wantedUpper);
    if (found) return found;

    // Handle "ঢাকা" input against "ঢাকা বিভাগ", etc.
    found = options.find(o => {
      const bn = norm(o.dataset.nameBn || o.textContent);
      const en = norm(o.dataset.nameEn || o.textContent).toUpperCase();
      return bn === wanted || bn.includes(wanted) || wanted.includes(bn) ||
             en === wantedUpper || en.includes(wantedUpper) || wantedUpper.includes(en);
    });

    // Zone/Ward labels are inconsistent across BDRIS screens. If the
    // supplied value contains a number, compare the numeric part against
    // the option text and data attributes, while requiring a geo label.
    const wantedNumber = numberToken(value);
    if (wantedNumber) {
      found = options.find(o => {
        const label = norm([o.textContent, o.value, o.dataset.nameBn, o.dataset.nameEn].filter(Boolean).join(" "));
        const isGeoLabel = /(zone|অঞ্চল|ward|ওয়ার্ড)/i.test(label);
        return isGeoLabel && numberToken(label) === wantedNumber;
      });
    }

    return found || null;
  }

  function fireSelectEvents(select) {
    if (!select) return;

    // Native events.
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    select.dispatchEvent(new Event("blur", { bubbles: true }));

    // Do not trigger jQuery here. BDRIS binds the same cascade to native
    // change; firing both causes duplicate AJAX calls and resets.
  }

  function selectNow(id, value, force = false) {
    const select = el(id);
    const option = findOption(select, value);

    if (!select || !option) return false;

    if (!force && String(select.value) === String(option.value)) return true;

    select.focus();
    select.value = option.value;
    fireSelectEvents(select);

    console.log(
      "[BDRIS AutoFill] selected",
      id,
      "=>",
      select.value,
      option.textContent.trim()
    );

    return true;
  }

  async function selectWhenReady(id, value, timeout = 12000, force = false) {
    if (value === undefined || value === null || value === "") return false;

    const started = Date.now();

    while (Date.now() - started < timeout) {
      if (selectNow(id, value, force)) {
        // BDRIS may redraw/reset the select immediately after its handler.
        // Verify that the requested option remains selected.
        await sleep(250);

        const select = el(id);
        const option = findOption(select, value);

        if (
          select &&
          option &&
          String(select.value) === String(option.value)
        ) {
          return true;
        }
      }

      await sleep(150);
    }

    console.warn("[BDRIS AutoFill] option not found/stable:", id, value);
    return false;
  }

  async function selectDivision(prefix, value) {
    const id = prefix + "Div";
    const select = el(id);
    if (!select || value === undefined || value === null || value === "") return false;

    const option = findOption(select, value);
    if (!option) {
      console.warn("[BDRIS AutoFill V3.1] division option not found:", prefix, value);
      return false;
    }

    // IMPORTANT: set the division once and fire the site's handlers once.
    // Re-triggering change repeatedly can cause BDRIS AJAX handlers to redraw
    // the dependent selects and reset already-filled address fields.
    select.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    if (setter) setter.call(select, String(option.value));
    else select.value = String(option.value);

    select.dispatchEvent(new Event("input", {bubbles:true}));
    select.dispatchEvent(new Event("change", {bubbles:true}));
    select.dispatchEvent(new Event("blur", {bubbles:true}));

    console.log("[BDRIS AutoFill V3.1] division selected:",
      id, select.value, option.textContent.trim());

    // Wait only for the dependent district list to be populated. Do NOT fire
    // another division change while waiting.
    const nextId = prefix + "Dist";
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const current = el(id);
      const next = el(nextId);
      if (current && String(current.value) === String(option.value) &&
          next && next.options && next.options.length > 1) {
        return true;
      }
      await sleep(150);
    }

    // The division itself is still selected even if the dependent AJAX list
    // takes longer than expected.
    return el(id)?.value === String(option.value);
  }

  function getGeoLocationId(prefix) {
    const node = el(prefix + "LocationId");
    const value = node?.value;
    return value == null ? "" : String(value).trim();
  }

  function getGeoLocationHiddenId(prefix) {
    const node = el(prefix + "GeolocationId");
    const value = node?.value;
    return value == null ? "" : String(value).trim();
  }

  function setHiddenGeoIds(prefix, locationId) {
    if (locationId === undefined || locationId === null || String(locationId).trim() === "") return false;
    const value = String(locationId).trim();
    const location = el(prefix + "LocationId");
    const geolocation = el(prefix + "GeolocationId");
    if (location) location.value = value;
    if (geolocation) geolocation.value = value;
    return !!(location || geolocation);
  }

  async function stabilizeGeoLocation(prefix, expectedId, timeout = 3000) {
    if (!expectedId || expectedId === "-1") return false;
    const deadline = Date.now() + timeout;
    let restored = false;

    while (Date.now() < deadline) {
      const current = getGeoLocationId(prefix);
      const hidden = getGeoLocationHiddenId(prefix);

      if (current === expectedId && (hidden === "" || hidden === expectedId)) {
        // Keep the hidden mirror synchronized without firing a change event.
        if (hidden !== expectedId) setHiddenGeoIds(prefix, expectedId);
        return true;
      }

      // BDRIS can asynchronously reset the location id to empty/-1 after a
      // dependent AJAX response. Restore the exact id that BDRIS itself
      // produced during this fill, but do not trigger change again.
      if (current !== expectedId || (hidden !== "" && hidden !== expectedId)) {
        restored = setHiddenGeoIds(prefix, expectedId) || restored;
      }

      await sleep(200);
    }

    return restored && getGeoLocationId(prefix) === expectedId;
  }

  async function geo(prefix, a) {
    if (!a) return {ok:false, reason:"missing address"};
    const required = async (id, value, timeout=15000) => {
      if (value === "" || value == null) return true;
      const ok = await selectWhenReady(id, value, timeout);
      if (!ok) console.error("[BDRIS AutoFill V3.3] STOP required field:", id, value);
      if (!ok) {
        const field = el(id);
        if (field) { field.style.outline = "3px solid #dc3545"; field.scrollIntoView({block:"center"}); }
        manualWarning("Auto-fill থেমে গেছে", `${id}<br>চাওয়া value: ${value}`);
      }
      return ok;
    };
    const selectAny = async (ids, value, timeout=18000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        for (const id of ids) {
          const node = el(id);
          if (node && findOption(node, value)) {
            if (await required(id, value, 3000)) return id;
          }
        }
        await sleep(200);
      }
      return "";
    };

    // Country
    await sleep(1400);
    const countryValue = a.country ?? a.countryBn ?? "1";
    if (!await selectWhenReady(prefix+"Country", countryValue, 7000, true)) return {ok:false,reason:"country",id:prefix+"Country"};
    await sleep(500);

    // The following are dependent selects. Trigger one, wait for the next options, continue.
    if (!await selectDivision(prefix, a.division ?? a.divisionBn)) return {ok:false,reason:"division",id:prefix+"Div"};
    if (!await required(prefix+"Dist", a.district ?? a.districtBn)) return {ok:false,reason:"district",id:prefix+"Dist"};
    if (!await required(prefix+"CityCorpCantOrUpazila", a.upazila ?? a.upazilaBn)) return {ok:false,reason:"upazila",id:prefix+"CityCorpCantOrUpazila"};
    if (!await required(prefix+"PaurasavaOrUnion", a.union ?? a.unionBn)) return {ok:false,reason:"union",id:prefix+"PaurasavaOrUnion"};

    // IMPORTANT: BDRIS uses data-geo-order, not the CSS class name, as the
    // reliable sequence. In City Corporation forms the order-5 select can
    // contain the Zone/Area values, while the order-6 select contains Ward.
    // Therefore do NOT assume WardInCityCorp === ward.
    const areaValue = a.area ?? a.areaBn ?? "";
    const wardValue = a.ward ?? a.wardBn ?? "";

    const order5 = el(prefix + "WardInCityCorp");
    const order6 = el(prefix + "Area");
    const order7 = el(prefix + "WardInPaurasavaOrUnion");

    // City Corporation: order 5 = area/zone, order 6 = ward.
    if (areaValue !== "") {
      const zoneId = await selectAny([prefix+"WardInCityCorp", prefix+"Area", prefix+"WardInPaurasavaOrUnion"], areaValue);
      if (!zoneId) return {ok:false,reason:"zone/area",id:prefix+"WardInCityCorp"};
    }

    if (wardValue !== "") {
      const wardId = await selectAny([prefix+"Area", prefix+"WardInPaurasavaOrUnion", prefix+"WardInCityCorp"], wardValue);
      if (!wardId) return {ok:false,reason:"ward",id:prefix+"Area"};
    }

    fillText(prefix+"PostOfc", a.postOfficeBn ?? a.postOffice);
    fillText(prefix+"PostOfcEn", a.postOfficeEn);
    fillText(prefix+"VilAreaTownBn", a.villageBn ?? a.village);
    fillText(prefix+"VilAreaTownEn", a.villageEn);
    fillText(prefix+"HouseRoadBn", a.houseRoadBn ?? a.houseBn ?? a.house);
    fillText(prefix+"HouseRoadEn", a.houseRoadEn ?? a.houseEn);
    fillText(prefix+"PostCode", a.postCode);

    // Keep the combined hidden fields populated when the site uses them.
    const bnParts = [
      a.houseRoadBn ?? a.houseBn ?? a.house,
      a.villageBn ?? a.village,
      a.postOfficeBn ?? a.postOffice,
      a.area ?? a.areaBn,
      a.ward,
      a.union ?? a.unionBn,
      a.upazila ?? a.upazilaBn,
      a.district ?? a.districtBn,
      a.division ?? a.divisionBn
    ].filter(Boolean);
    const enParts = [
      a.houseRoadEn ?? a.houseEn,
      a.villageEn,
      a.postOfficeEn,
      a.areaEn,
      a.wardEn,
      a.unionEn,
      a.upazilaEn,
      a.districtEn,
      a.divisionEn
    ].filter(Boolean);

    if (prefix === "birthPlace") {
      fillText("birthPlaceBn", bnParts.join(", "));
      fillText("birthPlaceEn", enParts.join(", "));
    } else if (prefix === "permAddr") {
      fillText("permAddrBn", bnParts.join(", "));
      fillText("permAddrEn", enParts.join(", "));
    } else if (prefix === "prsntAddr") {
      fillText("prsntAddrBn", bnParts.join(", "));
      fillText("prsntAddrEn", enParts.join(", "));
    }

    // Return the location id that BDRIS generated from the actual selected
    // geo option. The caller uses this as the authoritative value to protect
    // against a later async reset.
    const finalLocation = getGeoLocationId(prefix);
    if (!finalLocation || finalLocation === "-1") {
      console.error("[BDRIS AutoFill V3.3] STOP: final location id missing", prefix, finalLocation);
      return {ok:false,reason:"final location id missing",id:prefix+"LocationId"};
    }
    return {ok:true, locationId:finalLocation};
  }

  function splitName(bn, en) {
    const b = String(bn ?? "").trim().split(/\s+/);
    const e = String(en ?? "").trim().split(/\s+/);
    return {
      firstBn: b.shift() || "",
      lastBn: b.join(" "),
      firstEn: e.shift() || "",
      lastEn: e.join(" ")
    };
  }

  async function fill(data, addressType = "ALL") {
    data = cleanIncomingData(data || {});
    const p = data.person || {};
    const f = data.father || {};
    const m = data.mother || {};

    if (addressType === "BIRTHPLACE" || addressType === "PERMANENT") {
      if (!await selectOfficeType(addressType)) return;
      await sleep(1400);
    }

    // Supports both the nested schema and direct actual-ID keys.
    const ns = splitName(p.nameBn, p.nameEn);
    fillText("personFirstNameBn", p.firstNameBn ?? ns.firstBn);
    fillText("personLastNameBn", p.lastNameBn ?? ns.lastBn);
    fillText("personFirstNameEn", p.firstNameEn ?? ns.firstEn);
    fillText("personLastNameEn", p.lastNameEn ?? ns.lastEn);
    fillText("personNameBn", p.nameBn);
    fillText("personNameEn", p.nameEn);
    fillText("personBirthDate", p.birthDate);
    await selectWhenReady("thChild", p.childOrder);
    const gender = String(p.gender ?? "").trim().toUpperCase();
    await selectWhenReady("gender", gender === "MALE" || gender === "পুরুষ" ? "MALE" :
      gender === "FEMALE" || gender === "মহিলা" ? "FEMALE" :
      gender === "THIRD_GENDER" || gender === "তৃতীয় লিঙ্গ" ? "THIRD_GENDER" : p.gender);
    fillText("personNid", p.nid);
    fillText("religionOther", p.religionOther);

    fillText("fatherBrn", f.brn);
    fillText("fatherBirthDate", f.birthDate);
    fillText("fatherNameBn", f.nameBn);
    fillText("fatherNameEn", f.nameEn);
    fillText("fatherPassportNumber", f.passport);
    await selectWhenReady("fatherNationality", f.nationality);

    fillText("motherBrn", m.brn);
    fillText("motherBirthDate", m.birthDate);
    fillText("motherNameBn", m.nameBn);
    fillText("motherNameEn", m.nameEn);
    fillText("motherPassportNumber", m.passport);
    await selectWhenReady("motherNationality", m.nationality);

    // The office radio only selects the registration office address type.
    // It must not decide which form address blocks are filled. Always fill
    // permanent and present addresses, regardless of the selected radio.
    const permLocationId = await geo("permAddr", data.permanentAddress);
    if (!permLocationId.ok) { manualWarning("স্থায়ী ঠিকানার field পূরণ হয়নি", `${permLocationId.id}<br>${permLocationId.reason}`); return; }
    const presentLocationId = await geo("prsntAddr", data.presentAddress);
    if (!presentLocationId.ok) { manualWarning("বর্তমান ঠিকানার field পূরণ হয়নি", `${presentLocationId.id}<br>${presentLocationId.reason}`); return; }

    // BDRIS can finish a previous geo callback asynchronously. Complete the
    // two normal address blocks first, then run Birth Place last so its final
    // cascade cannot reset the other address blocks during their fill.
    await sleep(1200);
    // Birth Place is always the final address cascade, so late callbacks
    // cannot overwrite the other address blocks during their fill.
    const birthLocationId = await geo("birthPlace", data.birthPlace);
    if (!birthLocationId.ok) { manualWarning("জন্মস্থানের field পূরণ হয়নি", `${birthLocationId.id}<br>${birthLocationId.reason}`); return; }
    await sleep(1500);

    // IMPORTANT: BDRIS performs asynchronous address resets while dependent
    // geo lists are being populated. In some runs that callback can change a
    // previously valid LocationId to -1/empty after the visible address still
    // looks correct. Preserve the ids produced by BDRIS itself and restore
    // only if an async callback clears them. Never trigger another geo change.
    await sleep(700);
    // Never overwrite BDRIS hidden location IDs. The page's own cascade is
    // authoritative and must be allowed to finish before submit.

    console.log("[BDRIS AutoFill V3.3] native cascade completed", {
      birthPlace: getGeoLocationId("birthPlace"),
      permanent: getGeoLocationId("permAddr"),
      present: getGeoLocationId("prsntAddr")
    });

    // No final division re-trigger here. Re-triggering it after the full
    // address chain is populated can reset district/upazila/union/ward fields.

    const app = data.applicant || {};
    if (app.relation) {
      const r = el(app.relation);
      if (r?.type === "radio") {
        r.checked = true;
        r.dispatchEvent(new Event("change",{bubbles:true}));
      }
    }
    fillText("applicantBrn", app.brn);
    fillText("applicantDob", app.dob);
    fillText("applicantName", app.name);
    fillText("email", data.email ?? app.email);
    fillText("phone", data.phone ?? app.phone);

    // Safe checkboxes only when explicitly requested.
    if (data.copyBirthPlaceToPermAddr === true) {
      const c = el("copyBirthPlaceToPermAddr");
      if (c && !c.checked) c.click();
    }
    if (data.copyPermAddrToPrsntAddr === true) {
      const c = el("copyPermAddrToPrsntAddr");
      if (c && !c.checked) c.click();
    }

    console.log("[BDRIS AutoFill V3.1 Patched] completed. Review all fields before proceeding.");
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "BDRIS_UPLOAD_OPEN") {
      const input = document.querySelector("input[type='file'][name='files'], input[type='file']");
      if (!input) {
        console.warn("[BDRIS AutoFill] upload input not found");
        sendResponse({ok:false,error:"BDRIS upload input পাওয়া যায়নি। Upload section খুলুন।"});
        return;
      }
      input.click();
      console.log("[BDRIS AutoFill] BDRIS upload file picker opened");
      sendResponse({ok:true});
      return;
    }
    if (msg?.type === "BDRIS_UPLOAD_TYPE") {
      const selects=[...document.querySelectorAll("select")].filter(s=>s.offsetParent!==null && s.options.length>1);
      if(!selects.length){sendResponse({ok:false,error:"File Type ঘর পাওয়া যায়নি। আগে file যোগ করুন।"});return;}
      selects.forEach(s=>s.focus());
      sendResponse({ok:true,count:selects.length});
      return;
    }
    if (msg?.type === "BDRIS_UPLOAD_TYPE_VALUE") {
      const selects=[...document.querySelectorAll("select.attchment-type-upload")].filter(s=>s.offsetParent!==null);
      const select=selects[selects.length-1] || selects[0];
      const option=select && [...select.options].find(o=>String(o.value)===String(msg.value));
      if(!select || !option){sendResponse({ok:false,error:"File Type select বা option পাওয়া যায়নি। আগে document যোগ করুন।"});return;}
      select.value=option.value;
      select.dispatchEvent(new Event("change",{bubbles:true}));
      select.dispatchEvent(new Event("input",{bubbles:true}));
      sendResponse({ok:true});
      return;
    }
    if (msg?.type === "BDRIS_UPLOAD_START") {
      const start=[...document.querySelectorAll("button.start, input.start")].find(x=>x.offsetParent!==null);
      if(!start){sendResponse({ok:false,error:"Start button পাওয়া যায়নি। আগে file যোগ করুন।"});return;}
      start.click();
      sendResponse({ok:true});
      return;
    }
    if (msg?.type === "BDRIS_OPEN_APPLICATION") {
      const link = [...document.querySelectorAll("a[href]")].find(a =>
        a.getAttribute("href") === "/br/application" &&
        /জন্ম নিবন্ধন আবেদন/.test((a.innerText || a.textContent || "").trim())
      );
      if (link) {
        console.log("[BDRIS AutoFill] opening application from homepage");
        const target = new URL(link.getAttribute("href"), location.origin).href;
        // Navigate directly to the exact application href. A synthetic click
        // can be swallowed while the Bootstrap dropdown is open.
        location.assign(target);
      } else {
        console.warn("[BDRIS AutoFill] application link not found on homepage");
      }
      return;
    }
    if (msg?.type === "BDRIS_FILL") fill(msg.data || {}, msg.addressType || "ALL");
  });
})();
