Ahey can be embedded in any webpage using an `<iframe>`.

---

## 📋 Embed Code Example

Replace `your-room-here` with the room name you want to embed:

```html
<iframe
	src="https://ahey.ney/your-room-here?name=John"
	width="100%"
	height="600"
	style="border:0;"
	allow="camera; microphone; fullscreen; display-capture"
	frameborder="0"
></iframe>
```

---

## ⚙️ Supported URL Parameters

| Parameter | Description                                                       | Type    | Example | Default |
| --------- | ----------------------------------------------------------------- | ------- | ------- | ------- |
| `name`    | Adds a default name for the user.                                 | string  | `John`  | `null`  |
| `chat`    | Boolean to disable the chat feature. Set `false` to disable chat. | boolean | `false` | `true`  |
