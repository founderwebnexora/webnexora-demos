document.addEventListener("DOMContentLoaded", () => {
    // 1. Read parameters from the URL (e.g. ?business=Apex%20Rentals)
    const urlParams = new URLSearchParams(window.location.search);
    const businessName = urlParams.get('business');

    // 2. If a business name is provided in the URL, replace it everywhere
    if (businessName) {
      // Find all elements with the dynamic class and update text
      document.querySelectorAll('.dynamic-business-name').forEach(el => {
        el.textContent = businessName;
      });

      // Optionally update the browser tab title to match
      // It replaces "Al Noor" in the title with the new business name, or sets a clean title
      if (document.title.includes("Al Noor")) {
        document.title = document.title.replace("Al Noor", businessName);
      } else {
        document.title = `${businessName} — Where Every Journey Begins`;
      }
    }
});