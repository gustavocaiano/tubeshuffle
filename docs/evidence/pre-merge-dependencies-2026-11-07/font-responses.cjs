// Build-only fixture: no Google Fonts request or remote font asset is needed.
// This does not validate the actual production fonts or their rendering.
module.exports = {
  "https://fonts.googleapis.com/css2?family=Geist:wght@100..900&display=swap":
    "@font-face { font-family: 'Geist'; src: local('Arial'); font-weight: 100 900; }",
  "https://fonts.googleapis.com/css2?family=Geist+Mono:wght@100..900&display=swap":
    "@font-face { font-family: 'Geist Mono'; src: local('Courier New'); font-weight: 100 900; }",
};
