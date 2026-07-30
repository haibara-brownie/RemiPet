# 第三方许可声明

## Spine Runtimes（@esotericsoftware/spine-player, spine-webgl, spine-core）

本项目使用 Spine Runtimes 渲染骨骼动画。其许可**不是** MIT，而是
Spine Runtimes License Agreement，有两条硬性要求：

1. **每一位使用者必须自行持有有效的 Spine Editor 许可证**
   （Spine Editor 是 Esoteric Software 的商业软件）。
2. **以任何形式再分发 Spine Runtimes 时，必须包含该许可与版权声明。**

这两条的直接后果：**本项目只开源代码，不提供预构建的安装包。** 分发内嵌
Spine Runtimes 的构建产物给不持有 Spine Editor 许可的使用者，不符合该许可
条款。自行 clone、自备素材、本地构建自用不受此影响——但请确认你自己符合
第 1 条。

许可原文如下（转载自 node_modules/@esotericsoftware/spine-player/LICENSE）：

```
Spine Runtimes License Agreement
Last updated April 5, 2025. Replaces all prior versions.

Copyright (c) 2013-2025, Esoteric Software LLC

Integration of the Spine Runtimes into software or otherwise creating
derivative works of the Spine Runtimes is permitted under the terms and
conditions of Section 2 of the Spine Editor License Agreement:
http://esotericsoftware.com/spine-editor-license

Otherwise, it is permitted to integrate the Spine Runtimes into software
or otherwise create derivative works of the Spine Runtimes (collectively,
"Products"), provided that each user of the Products must obtain their own
Spine Editor license and redistribution of the Products in any form must
include this license and copyright notice.

THE SPINE RUNTIMES ARE PROVIDED BY ESOTERIC SOFTWARE LLC "AS IS" AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL ESOTERIC SOFTWARE LLC BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES,
BUSINESS INTERRUPTION, OR LOSS OF USE, DATA, OR PROFITS) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
THE SPINE RUNTIMES, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
