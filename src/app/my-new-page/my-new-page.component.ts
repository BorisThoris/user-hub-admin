import { Component, OnInit } from '@angular/core';
import { Router, ActivatedRoute, ParamMap } from '@angular/router';

import { AlertCompComponent } from '../alert-comp/alert-comp.component';

@Component({
  selector: 'app-my-new-page',
  templateUrl: './my-new-page.component.html',
  styleUrls: ['./my-new-page.component.css'],
})
export class MyNewPageComponent implements OnInit {
  //     var currentColor = localStorage.getItem('bgcolor');
  // var currentFont = localStorage.getItem('font');
  // var currentImage = localStorage.getItem('image');

  parentMessage: string = 'Demo State Reset';
  alertOpen: boolean = false;

  begginingCircles: {
    id: number;
    step: string;
    description: string;
    status: boolean;
    actionText: string;
    locateTo: string;
  }[] = [
    {
      id: 0,
      step: 'Create users',
      description: 'Open the user manager and create a demo user set.',
      status: false,
      actionText: 'Manage users',
      locateTo: '/control-users',
    },
    {
      id: 1,
      step: 'Review directory',
      description: 'Review the generated users in the directory.',
      status: false,
      actionText: 'View directory',
      locateTo: '/view-users',
    },
    {
      id: 2,
      step: 'Reset state',
      description: 'Clear the local demo state when you are ready to repeat the flow.',
      status: false,
      actionText: '',
      locateTo: '',
    },
  ];

  tempCircles;
  constructor(private route: ActivatedRoute, private router: Router) {}

  ngOnInit(): void {
    this.tempCircles = JSON.parse(localStorage.getItem('circles'));
    if (this.tempCircles === null) this.getCircles();
  }

  getCircles(): void {
    this.tempCircles = this.begginingCircles.map((obj) => ({ ...obj }));
    localStorage.setItem('circles', JSON.stringify(this.tempCircles));
  }

  updateSingleCircle(index): void {
    var currentCircle = this.tempCircles[index];

    currentCircle.status = true;
    this.updateCirclesState();
    this.router.navigate([`${currentCircle.locateTo}`]);
  }

  resetCircles(): void {
    localStorage.clear();
    this.getCircles();
    this.showAlert();
  }

  updateCirclesState(): void {
    localStorage.setItem('circles', JSON.stringify(this.tempCircles));
  }

  showAlert(): void {
    this.alertOpen = true;

    setTimeout(() => {
      this.alertOpen = false;
    }, 3000);
  }
}
