# Rich content, safely rendered

<details>
<summary>Expand the details</summary>
<p>Embedded HTML remains useful and readable.</p>
</details>

Native MathML: <math><mi>x</mi><mo>+</mo><mn>1</mn></math>

## Document-relative images

![Omarkd diagram](image.svg)

<script>window.omarkdInjected = true;</script>
<iframe src="https://example.com"></iframe>
<img hidden alt="Removed event handler" src="data:image/png;base64,broken" onerror="window.omarkdInjected = true">
<a href="javascript:alert('blocked')">Unsafe link without an active URL</a>
