!function () {


    $('.send-captcha').click(async function () {
        if (this.disabled) return;
        this.disabled = true;
        let captcha;
        let sending = false;
        try {
            const {mountCaptcha} = await import('/ui/captcha.js');
            const image = document.createElement('img');
            image.alt = i18n('图片验证码');
            const trigger = document.createElement('button');
            trigger.type = 'button';
            trigger.setAttribute('aria-label', i18n('更换验证码'));
            trigger.append(image, document.createTextNode(i18n('更换验证码')));
            const status = document.createElement('p');
            const content = document.createElement('div');
            content.append(trigger, status);
            const result = await message.prompt({
                title: i18n('人机验证'), width: 420, html: content,
                confirmButtonText: i18n('继续操作'),
                didOpen: () => {
                    captcha = mountCaptcha({action: 'phoneBindNew', image,
                        input: Swal.getInput(), trigger, status});
                },
                inputValidator: (value) => {
                    if (!captcha?.ready) return i18n('请先加载有效的图片验证码。');
                    return !/^[A-Za-z2-9]{4}$/.test(value.trim()) && i18n('请输入图片中的 4 位字符。');
                },
                preConfirm: () => captcha.fields(),
                willClose: () => captcha?.dispose()
            });
            if (!result.isConfirmed) return;
            sending = true;
            util.post("/user/api/security/phoneBindNew", {
                ...result.value, phone: $('input[name=phone]').val()
            }, () => {
                util.countDown(this, 60);
                message.success("验证码发送成功");
            }, (response) => {
                this.disabled = false;
                message.error(response.msg);
            }, () => {
                this.disabled = false;
                message.error("网络错误，请重新获取图片验证码后再试");
            });
        } catch {
            message.error("验证码组件加载失败，请刷新页面后重试");
        } finally {
            captcha?.dispose();
            if (!sending) this.disabled = false;
        }
    });


    $('.save-data').click(function () {
        util.post("/user/api/security/phone", util.getFormData('.form-data'), res => {
            message.success("绑定成功");
            setTimeout(() => {
                window.location.reload();
            }, 1500);
        })
    });
}();
