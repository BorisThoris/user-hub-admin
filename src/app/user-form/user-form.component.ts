import { Component, OnInit, Input, Output, EventEmitter } from '@angular/core';

@Component({
  selector: 'user-form-comp',
  template: `
    <div class="clr-form-control clr-row">
      <label for="example" class="clr-control-label clr-col-12 clr-col-md-2"
        >Username:
      </label>

      <div class="clr-input-wrapper">
        <input
          class="clr-input"
          type="text"
          [value]="userName"
          #username
          (keyup)="update(username.value, 'name', idx)"
        />
      </div>
    </div>

    <!-- Spacer -->
    <div class="clr-form-control clr-row">
      <label for="example" class="clr-control-label clr-col-12 clr-col-md-2"
        >Avatar URL:
      </label>

      <div class="clr-input-wrapper">
        <input
          class="clr-input"
          type="text"
          [value]="userAvatarUrl"
          #avatarUrl
          (keyup)="update(avatarUrl.value, 'avatarUrl', idx)"
        />
      </div>
    </div>
  `,
})
export class UserFormComponent implements OnInit {
  constructor() {}

  avatarUrl: string = '';

  @Input() userName;
  @Input() userAvatarUrl;
  @Input() users;
  @Input() idx;
  @Output() onKeyUpEvent = new EventEmitter<any>();
  @Output() onSubmitEvent = new EventEmitter<any>();

  ngOnInit(): void {}

  update(value, type, index) {
    // alert('sad');
    this.onKeyUpEvent.emit({ value, type, index });
  }

  submit() {
    this.onSubmitEvent.emit();
  }
}
