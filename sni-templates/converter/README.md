Чтобы загрузить шаблон себе, перейдите в папку, указанную в конфиге nginx вашего сайта и выполните следующие команды

<pre lang="markdown">
mkdir -p assets
wget https://raw.githubusercontent.com/SmallPoppa/sni-templates/ecbfc37b9fa62663320120fe637e60ff3243ff4e/converter/apple-touch-icon.png
wget https://raw.githubusercontent.com/SmallPoppa/sni-templates/ecbfc37b9fa62663320120fe637e60ff3243ff4e/converter/favicon-96x96.png
wget https://raw.githubusercontent.com/SmallPoppa/sni-templates/ecbfc37b9fa62663320120fe637e60ff3243ff4e/converter/favicon.ico
wget https://raw.githubusercontent.com/SmallPoppa/sni-templates/ecbfc37b9fa62663320120fe637e60ff3243ff4e/converter/favicon.svg
wget https://raw.githubusercontent.com/SmallPoppa/sni-templates/ecbfc37b9fa62663320120fe637e60ff3243ff4e/converter/index.html
wget https://raw.githubusercontent.com/SmallPoppa/sni-templates/ecbfc37b9fa62663320120fe637e60ff3243ff4e/converter/site.webmanifest
wget https://raw.githubusercontent.com/SmallPoppa/sni-templates/ecbfc37b9fa62663320120fe637e60ff3243ff4e/converter/web-app-manifest-192x192.png
wget https://raw.githubusercontent.com/SmallPoppa/sni-templates/ecbfc37b9fa62663320120fe637e60ff3243ff4e/converter/web-app-manifest-512x512.png
wget https://raw.githubusercontent.com/SmallPoppa/sni-templates/ecbfc37b9fa62663320120fe637e60ff3243ff4e/converter/assets/script.js   -P assets
wget https://raw.githubusercontent.com/SmallPoppa/sni-templates/ecbfc37b9fa62663320120fe637e60ff3243ff4e/converter/assets/style.css    -P assets
</pre>

Нужные файлы будут загружены, а папка assets создастся автоматически.
