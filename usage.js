// Export button and the page's one scroll moment (word-highlight, written here because the kit shipped no moment files).
const CSV = "usage.csv";

document.addEventListener("click", async (e) => {
  const button = e.target.closest("[data-export]");
  if (!button) return;
  const label = button.textContent;
  button.disabled = true;
  try {
    const response = await fetch(CSV, { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = CSV;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    window.location.href = CSV; // file:// and offline fallback: let the browser take the file
  } finally {
    setTimeout(() => { button.disabled = false; button.textContent = label; }, 600);
  }
});

const section = document.querySelector("[data-scroll-moment]");
const words = section ? [...section.querySelectorAll("[data-word]")] : [];

const light = (count) => {
  words.forEach((word, i) => word.classList.toggle("is-lit", i < count));
};

if (words.length && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  let last = -1;
  let ticking = false;
  const paint = () => {
    ticking = false;
    const rect = section.getBoundingClientRect();
    const travel = rect.height + window.innerHeight * 0.6;
    const progress = Math.min(1, Math.max(0, (window.innerHeight * 0.85 - rect.top) / travel));
    const count = Math.round(progress * words.length);
    if (count !== last) { last = count; light(count); }
  };
  addEventListener("scroll", () => {
    if (!ticking) { ticking = true; requestAnimationFrame(paint); }
  }, { passive: true });
  addEventListener("resize", paint);
  paint();
} else {
  light(words.length);
}
