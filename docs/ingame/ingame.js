function getStageKey() {
  const params = new URLSearchParams(window.location.search);
  return params.get("stage") || "GEN-01";
}

function log(msg) {
  const el = document.getElementById("stageLog");
  if (!el) return;
  el.textContent += (el.textContent ? "\n" : "") + msg;
}

async function loadStage(stageKey) {
  const codeEl = document.getElementById("stageCode");
  const titleEl = document.getElementById("stageTitle");
  const descEl = document.getElementById("stageDesc");
  const listEl = document.getElementById("stageObjectives");

  if (codeEl) codeEl.textContent = stageKey;

  try {
    const res = await fetch(`../stages/${stageKey}.json`);
    if (!res.ok) throw new Error(`stage load failed: ${res.status}`);
    const data = await res.json();

    if (titleEl) titleEl.textContent = data.title || stageKey;
    if (descEl) descEl.textContent = data.description || "";
    if (listEl) {
      listEl.innerHTML = "";
      (data.objectives || []).forEach((item) => {
        const li = document.createElement("li");
        li.textContent = item;
        listEl.appendChild(li);
      });
    }
    log(`스테이지 로드 완료: ${stageKey}`);
  } catch (err) {
    if (titleEl) titleEl.textContent = "스테이지 로드 실패";
    if (descEl) descEl.textContent = "스테이지 데이터를 불러오지 못했습니다.";
    if (listEl) listEl.innerHTML = "";
    log(String(err));
  }
}

loadStage(getStageKey());
